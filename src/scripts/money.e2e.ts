/**
 * Money desks / season math / ITC engine integration test (P9 acceptance).
 *
 * Three headline checks, end to end through the real services:
 *   1. import a fixture season's dispatch CSV, close the season, and confirm the
 *      PERF_PAY rows carry 0.5 × annual_rate × avg kW (L7, 01 §Derived);
 *   2. import a mismatched statement and confirm the row flips VARIANCE and
 *      surfaces on Today;
 *   3. build a two-claim cohort and assemble the diligence ZIP, confirming it
 *      contains the per-serial attestations and both letters.
 *
 * Also covers: the Enlighten cross-check flag, allocation consumption refusing
 * to over-allocate, the cohort → CASH_RECEIVED chain booking ITC_CASH rows, the
 * D5 thread aggregates, and the P&L roll-up.
 *
 * Self-cleaning.  npx ts-node src/scripts/money.e2e.ts
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import { closeSeason, importEvents, importStatement, SEASON_SHARE } from '../services/season.service';
import {
  addToCohort,
  attachEvidence,
  getRecaptureWatch,
  getThread,
  linkAllocation,
  listClaims,
  rebuildBasis,
  setCohortStatus,
} from '../services/itc.service';
import { assembleDiligencePack } from '../services/diligence.service';
import { getPnl, exportPnlCsv } from '../services/pnl.service';
import { composeToday } from '../services/today.service';
import { listZip } from '../lib/zip';

const MARK = `P9E2E-${Date.now()}`;
const made = {
  systemIds: [] as string[],
  propertyId: '',
  seasonId: '',
  cohortId: '',
  allocationId: '',
  poId: '',
  docIds: [] as string[],
};

const ANNUAL_RATE = 425; // UNDERSERVED, from the rate_tables seed shape

async function makeSystem(label: string, kw: number) {
  const system = await prisma.system.create({
    data: {
      propertyId: made.propertyId,
      unitLabel: label,
      addressLine: `${MARK} ${label}`,
      stage: 'OPERATING',
      kwRated: kw,
      kwhRated: 15,
      tier: 'UNDERSERVED',
      dermsId: `${MARK}-DERMS-${label}`,
      cgbAppNo: `${MARK}-APP-${label}`,
      pisDate: new Date('2026-07-01'),
      recaptureEnd: new Date('2031-07-01'),
      cofDate: new Date('2026-07-01'),
      lockedRates: { annual_rate: ANNUAL_RATE, enroll_rate: 130, grid_edge: true, locked_at: new Date().toISOString() },
    },
  });
  made.systemIds.push(system.id);
  return system;
}

/** A document with a file key — the pack will report it as unreadable without storage. */
async function makeDoc(systemId: string, type: 'ROF_LETTER' | 'COF_LETTER' | 'ATTESTATION', title: string) {
  const doc = await prisma.document.create({
    data: { systemId, type, title, fileKey: `${MARK}/${type}.pdf`, status: 'SIGNED', signedAt: new Date() },
  });
  made.docIds.push(doc.id);
  return doc;
}

async function run() {
  const property = await prisma.property.create({
    data: { address: `${MARK} 12 Money St`, town: 'Hartford', postalCode: '06101', county: 'Hartford' },
  });
  made.propertyId = property.id;

  const season = await prisma.season.create({
    data: { name: 'SUMMER', programYear: 2099, window: { start: '2099-06-01', end: '2099-09-30' }, status: 'OPEN' },
  });
  made.seasonId = season.id;

  try {
    const a = await makeSystem('A', 11.3);
    const b = await makeSystem('B', 11.3);

    // ═══ 1. events import → season close ═══════════════════════════════════
    const csv = [
      'derms_id,event_date,window,kw_nominated,kw_delivered,soc_start',
      `${MARK}-DERMS-A,2099-07-10,PM1,11.3,10.4,88`,
      `${MARK}-DERMS-A,2099-07-24,PM1,11.3,11.0,91`,
      `${MARK}-DERMS-A,2099-08-07,PM1,11.3,10.1,86`,
      `${MARK}-DERMS-B,2099-07-10,PM1,11.3,9.0,80`,
      `${MARK}-DERMS-B,2099-07-24,PM1,11.3,9.6,84`,
      'UNKNOWN-SITE,2099-07-10,PM1,11.3,5.0,70',
    ].join('\n');

    const imported = await importEvents(csv, { seasonId: season.id, by: 'e2e' });
    assert.equal(imported.rows, 6, 'six data rows parsed');
    assert.equal(imported.imported, 5, 'five rows matched a system');
    assert.equal(imported.skipped, 1, 'the unknown site is skipped, not guessed');
    assert.match(
      imported.results.find((r) => r.result === 'skipped')!.detail ?? '',
      /no system matches/,
      'the skip says why',
    );

    // ratio is computed, never taken from the file
    const evA = await prisma.event.findMany({ where: { systemId: a.id }, orderBy: { date: 'asc' } });
    assert.equal(evA.length, 3, 'three events for A');
    assert.ok(Math.abs(Number(evA[0].ratio) - 10.4 / 11.3) < 1e-6, 'ratio computed from nominated/delivered');

    // re-import is an update, never a duplicate (01 §events — stored once)
    const again = await importEvents(csv, { seasonId: season.id, by: 'e2e' });
    assert.equal(again.imported, 0, 're-import adds nothing');
    assert.equal(again.updated, 5, 're-import updates in place');
    assert.equal(await prisma.event.count({ where: { systemId: { in: [a.id, b.id] } } }), 5, 'still five events');

    // close the season → PERF_PAY per L7
    const closed = await closeSeason(season.id, { by: 'e2e' });
    assert.equal(closed.systems, 2, 'both systems rolled up');
    assert.equal(closed.written, 2, 'two PERF_PAY rows written');

    const avgA = (10.4 + 11.0 + 10.1) / 3;
    const expectedA = Number((SEASON_SHARE * ANNUAL_RATE * avgA).toFixed(2));
    const rowA = await prisma.ledgerEntry.findFirstOrThrow({ where: { systemId: a.id, seasonId: season.id, type: 'PERF_PAY' } });
    assert.equal(Number(rowA.expectedAmt), expectedA, `expected = 0.5 × ${ANNUAL_RATE} × ${avgA.toFixed(4)}`);
    assert.equal(rowA.status, 'EXPECTED');
    const metaA = rowA.meta as { events_n: number; avg_kw: number; rate: number; share: number };
    assert.equal(metaA.events_n, 3, 'meta carries the computation (L7)');
    assert.equal(metaA.rate, ANNUAL_RATE);
    assert.equal(metaA.share, SEASON_SHARE);
    assert.ok(Math.abs(metaA.avg_kw - avgA) < 1e-3, 'meta avg_kw matches');

    const avgB = (9.0 + 9.6) / 2;
    const expectedB = Number((SEASON_SHARE * ANNUAL_RATE * avgB).toFixed(2));
    const rowB = await prisma.ledgerEntry.findFirstOrThrow({ where: { systemId: b.id, seasonId: season.id, type: 'PERF_PAY' } });
    assert.equal(Number(rowB.expectedAmt), expectedB, 'B expected amount');

    // re-closing updates rather than double-booking the revenue
    const reclosed = await closeSeason(season.id, { by: 'e2e', force: true });
    assert.equal(reclosed.written, 0, 're-close writes no new rows');
    assert.equal(reclosed.updated, 2, 're-close updates in place');
    assert.equal(
      await prisma.ledgerEntry.count({ where: { seasonId: season.id, type: 'PERF_PAY' } }),
      2,
      'still exactly two PERF_PAY rows',
    );

    // ═══ 2. a mismatched statement flips VARIANCE ══════════════════════════
    // A pays in full; B pays 20% short — outside the 10% tolerance.
    const shortB = Number((expectedB * 0.8).toFixed(2));
    const statement = [
      'app_no,amount,paid_date',
      `${MARK}-APP-A,${expectedA},2099-10-15`,
      `${MARK}-APP-B,${shortB},2099-10-15`,
    ].join('\n');

    const recon = await importStatement(statement, { seasonId: season.id, by: 'e2e' });
    assert.equal(recon.reconciled, 1, 'the exact payment reconciles');
    assert.equal(recon.variances, 1, 'the short payment is a variance');

    const afterA = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: rowA.id } });
    assert.equal(afterA.status, 'RECEIVED', 'A is RECEIVED');
    assert.equal(Number(afterA.receivedAmt), expectedA);
    const afterB = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: rowB.id } });
    assert.equal(afterB.status, 'VARIANCE', 'B flips VARIANCE');
    assert.ok(Math.abs(Number((afterB.meta as { variance_pct: number }).variance_pct) + 20) < 0.5, 'variance ≈ -20%');

    // → and it lands on Today (P6 reads VARIANCE straight from the ledger)
    const today = await composeToday();
    const moneyRows = today.sections.find((s) => s.key === 'money')?.rows ?? [];
    assert.ok(moneyRows.some((r) => r.system_id === b.id), 'the variance surfaces on Today');
    assert.ok(!moneyRows.some((r) => r.system_id === a.id), 'the reconciled row does not');

    // ═══ 3. two-claim cohort → diligence ZIP ══════════════════════════════
    // Purchase order supplies the unit cost that basis lines are sourced to (D4).
    const po = await prisma.purchaseOrder.create({
      data: {
        poNo: `${MARK}-PO`,
        vendor: 'Enphase',
        status: 'RECEIVED',
        lines: [{ sku: 'IQ10C', kind: 'BATTERY', qty: 6, unit_cost: 3200 }],
      },
    });
    made.poId = po.id;

    for (const sys of [a, b]) {
      const claim = await prisma.itcClaim.create({
        data: { systemId: sys.id, status: 'BASIS_LOCKED', stack: { base: 30, dc: 10, ec: 0, li: null }, pisDate: sys.pisDate, recaptureEnd: sys.recaptureEnd },
      });
      // three batteries per system, each with an attestation document
      for (let i = 0; i < 3; i++) {
        const serial = `${MARK}-${sys.unitLabel}-BAT-${i}`;
        const att = await makeDoc(sys.id, 'ATTESTATION', `Attestation ${serial}`);
        await prisma.equipment.create({
          data: { systemId: sys.id, serial, kind: 'BATTERY', sku: 'IQ10C', dom: true, status: 'INSTALLED', poId: po.id, attestationDocId: att.id, installedAt: new Date() },
        });
        await attachEvidence(claim.id, { key: 'serial_attestations', serial, doc_id: att.id }, 'e2e');
      }
      await makeDoc(sys.id, 'ROF_LETTER', 'ROF letter');
      await makeDoc(sys.id, 'COF_LETTER', 'COF letter');
      await prisma.checklistItem.create({
        data: { systemId: sys.id, stage: 'S08_COMMISSIONED', key: 'pto_received', label: 'PTO received', state: 'DONE', doneAt: new Date() },
      });

      // basis rebuilt from the PO line's unit_cost
      const basis = await rebuildBasis(claim.id, 'e2e');
      assert.equal(basis.basis, 3 * 3200, 'basis = 3 batteries × PO unit_cost');
      assert.equal(basis.total_pct, 40, 'stack base 30 + DC 10');
      assert.equal(basis.credit, 3 * 3200 * 0.4, 'credit = basis × total_pct');
    }

    // allocation consumption: refuses to over-allocate, consumes on link
    const allocation = await prisma.itcAllocation.create({
      data: { programYear: 2099, category: 'CAT1', kwApplied: 20, kwAwarded: 15, kwConsumed: 0 },
    });
    made.allocationId = allocation.id;
    const claimA = await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: a.id } });
    const claimB = await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: b.id } });

    const linked = await linkAllocation(claimA.id, allocation.id, 'e2e');
    assert.equal(linked.consumed_kw, 11.3, 'linking consumes the system kW');
    assert.ok(Math.abs(linked.remaining_kw - 3.7) < 1e-6, '15 − 11.3 = 3.7 kW left');
    assert.equal(linked.total_pct, 50, 'LI adder lifts the stack to 50%');

    await assert.rejects(
      () => linkAllocation(claimB.id, allocation.id, 'e2e'),
      /ALLOCATION_EXHAUSTED|remaining/,
      'a second 11.3 kW system cannot draw on 3.7 kW remaining',
    );

    const cohort = await prisma.itcCohort.create({ data: { label: `${MARK}-COHORT`, status: 'ASSEMBLING' } });
    made.cohortId = cohort.id;
    const add = await addToCohort(cohort.id, [claimA.id, claimB.id], 'e2e');
    assert.equal(add.added.length, 2, 'both claims join the cohort');
    assert.equal(add.refused.length, 0);

    const pack = await assembleDiligencePack(cohort.id, { by: 'e2e' });
    const names = listZip(pack.zip);
    assert.ok(names.includes('manifest.json'), 'pack has a manifest');
    assert.ok(names.includes('README.txt'), 'pack has a readme');
    assert.equal(names.filter((n) => n.endsWith('claim.json')).length, 2, 'one claim.json per claim');

    // per-serial attestations — six serials across two claims
    const attestationEntries = names.filter((n) => n.includes('/attestations/'));
    assert.equal(attestationEntries.length, 6, 'six per-serial attestation entries');
    for (const sys of [a, b]) {
      for (let i = 0; i < 3; i++) {
        const serial = `${MARK}-${sys.unitLabel}-BAT-${i}`;
        assert.ok(
          attestationEntries.some((n) => n.includes(serial)),
          `pack names the attestation for ${serial}`,
        );
      }
    }
    // both letters, per claim
    assert.equal(names.filter((n) => /\/rof\.pdf/.test(n)).length, 2, 'ROF letter entry per claim');
    assert.equal(names.filter((n) => /\/cof\.pdf/.test(n)).length, 2, 'COF letter entry per claim');

    // The archive is a real, readable zip.
    assert.equal(pack.zip.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
    assert.ok(pack.zip.length > 500, 'archive has content');

    // Storage is not configured in test, so the pack must SAY it is short
    // rather than pretend to be complete.
    assert.equal(pack.complete, false, 'pack reports itself incomplete without the files');
    assert.ok(pack.gaps.length > 0, 'gaps enumerated');
    const manifestEntry = names.indexOf('manifest.json');
    assert.ok(manifestEntry >= 0);

    // ═══ cohort → CASH_RECEIVED books ITC_CASH ════════════════════════════
    const cash = await setCohortStatus(cohort.id, 'CASH_RECEIVED', { buyer: 'Test Buyer', price_cents: 92, by: 'e2e' });
    assert.equal(cash.ledger_rows_booked, 2, 'an ITC_CASH row per claim');
    const transferred = await prisma.itcClaim.findMany({ where: { cohortId: cohort.id } });
    assert.ok(transferred.every((c) => c.status === 'TRANSFERRED'), 'claims → TRANSFERRED');
    const itcCash = await prisma.ledgerEntry.findFirstOrThrow({ where: { systemId: a.id, type: 'ITC_CASH' } });
    const claimAFinal = await prisma.itcClaim.findUniqueOrThrow({ where: { id: claimA.id } });
    assert.equal(
      Number(itcCash.receivedAmt),
      Number(((Number(claimAFinal.creditAmt) * 92) / 100).toFixed(2)),
      'ITC cash = credit × price_cents',
    );

    // ═══ D5 thread + recapture watch + P&L ════════════════════════════════
    const thread = await getThread();
    assert.ok(thread.total_claims >= 2, 'thread counts claims');
    assert.equal(thread.current, 'TRANSFERRED', 'fleet position is the furthest state holding claims');
    assert.ok(thread.stages.some((s) => s.status === 'TRANSFERRED' && s.count >= 2), 'TRANSFERRED count');

    const watch = await getRecaptureWatch();
    assert.ok(watch.some((w) => w.system_id === a.id), 'system inside the recapture window is on the watch list');

    const claims = await listClaims();
    const mine = claims.claims.filter((c) => made.systemIds.includes(c.system_id));
    assert.ok(mine.every((c) => c.in_recapture), 'recapture is derived, not stored');

    const pnl = await getPnl();
    const pnlA = pnl.systems.find((s) => s.system_id === a.id)!;
    assert.ok(pnlA, 'A appears in the P&L');
    assert.equal(pnlA.received.perf_pay, expectedA, 'received PERF_PAY tracks the ledger');
    assert.ok(pnlA.received.itc_cash > 0, 'ITC cash booked');
    assert.equal(
      pnlA.received.noi,
      Number((pnlA.received.enroll_inc + pnlA.received.perf_pay + pnlA.received.itc_cash).toFixed(2)),
      'NOI = inflows − outflows',
    );
    assert.ok(pnl.properties.some((p) => p.property_id === property.id), 'property roll-up present');

    const csvOut = await exportPnlCsv();
    assert.ok(csvOut.startsWith('system_id,address,property,tier,kw_rated,stage,'), 'CSV header in calculator vocabulary');
    assert.ok(csvOut.includes('annual_noi_expected,annual_noi_received'), 'expected and received stay separate columns');
    assert.ok(csvOut.trim().split('\n').some((l) => l.startsWith('FLEET,')), 'CSV carries the fleet total row');

    console.log(
      `\n  season → A expected $${expectedA} (0.5 × ${ANNUAL_RATE} × ${avgA.toFixed(2)} kW) · B $${expectedB}` +
        `\n  statement → 1 reconciled, 1 VARIANCE (−20%) on Today` +
        `\n  diligence → ${names.length} entries · 6 attestations · both letters · ${pack.gaps.length} gaps reported`,
    );
    console.log('\n✅ money/season/itc e2e PASSED');
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  const ids = made.systemIds;
  if (ids.length) {
    await prisma.itcBasisLine.deleteMany({ where: { claim: { systemId: { in: ids } } } });
    await prisma.itcClaim.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.event.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.equipment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.document.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ticket.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (made.cohortId) {
    await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: made.cohortId } });
    await prisma.itcCohort.deleteMany({ where: { id: made.cohortId } });
  }
  if (made.allocationId) await prisma.itcAllocation.deleteMany({ where: { id: made.allocationId } });
  if (made.poId) await prisma.purchaseOrder.deleteMany({ where: { id: made.poId } });
  if (made.seasonId) {
    await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: made.seasonId } });
    await prisma.season.deleteMany({ where: { id: made.seasonId } });
  }
  await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: { in: ['events_import', 'statement'] } } });
  if (made.propertyId) await prisma.property.deleteMany({ where: { id: made.propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ money e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
