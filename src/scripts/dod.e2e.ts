/**
 * Definition-of-done E2E (P10). One script, five sentences from 00 §Definition
 * of done, each asserted end to end through the public surface.
 *
 *   1. A new address travels S01 → Operating entirely inside the app: every gate
 *      server-enforced, every transition in stage_history, all five external IDs
 *      captured at their moment.
 *   2. An Operating system that goes dark raises its own alert, opens its own
 *      ticket by rule, gets a crew on the crew board, and closes only on
 *      machine-verified telemetry — installer of record displayed throughout.
 *   3. A season closes into per-system PERF_PAY rows; the statement import
 *      reconciles them; variances land on Today.
 *   4. A quarterly ITC cohort assembles claims, and one click produces the
 *      buyer's diligence ZIP from evidence attached to serials and letters.
 *   5. Days-in-stage, blocked age and every clock render from stage_history +
 *      date fields with zero manual bookkeeping.
 *
 * Plus the turnover loop (02 §Automations) — four artifacts close the case and
 * clear the flag.
 *
 * Self-cleaning.  npm run test:dod
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import {
  advance,
  applyChecklist,
  logDocument,
  onSnapshotWritten,
  onWorkOrderCheckout,
  evaluateClocks,
  LifecycleError,
  STAGE_ORDER,
} from '../lib/lifecycle';
import { pollFleet } from '../services/poller.service';
import { assignTicket, getTicket } from '../services/service.service';
import { getBoard } from '../services/crew.service';
import { checkIn, captureSerials, confirmActivation } from '../services/field.service';
import { closeSeason, importEvents, importStatement, SEASON_SHARE } from '../services/season.service';
import { addToCohort } from '../services/itc.service';
import { assembleDiligencePack } from '../services/diligence.service';
import { composeToday } from '../services/today.service';
import { getBoard as getPipelineBoard } from '../services/pipeline.service';
import { reportMoveOut, setTurnoverTask, listTurnovers, TURNOVER_TASKS } from '../services/turnover.service';
import { listZip } from '../lib/zip';
import { verifyTicket } from '../lib/lifecycle';

const MARK = `DOD-${Date.now()}`;
const HOUR = 3_600_000;
const made = {
  systemIds: [] as string[],
  propertyId: '',
  siteIds: [] as string[],
  seasonId: '',
  cohortId: '',
  crewId: '',
  installerId: '',
  poId: '',
};
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

const say = (n: number, text: string) => console.log(`\n  ── DoD ${n} — ${text}`);

async function run() {
  const property = await prisma.property.create({
    data: { address: `${MARK} 1 Done St`, town: 'Greenwich', postalCode: '06830', county: 'Fairfield', lat: 41.02, lng: -73.62 },
  });
  made.propertyId = property.id;

  const installer = await prisma.installer.create({ data: { orgName: `${MARK} Installer`, selfPerform: false } });
  made.installerId = installer.id;
  const crew = await prisma.crew.create({
    data: { installerId: installer.id, label: 'Crew A', capacityPerDay: 3, members: [{ name: 'M. Rivera', license: 'E2-118' }] },
  });
  made.crewId = crew.id;

  const po = await prisma.purchaseOrder.create({
    data: { poNo: `${MARK}-PO`, vendor: 'Enphase', status: 'RECEIVED', lines: [{ sku: 'IQ10C', kind: 'BATTERY', qty: 6, unit_cost: 3200 }] },
  });
  made.poId = po.id;

  try {
    // ══════════════════════════════════════════════════════════════════════
    say(1, 'a new address travels S01 → Operating inside the app');
    // ══════════════════════════════════════════════════════════════════════
    const system = await prisma.system.create({
      data: {
        propertyId: property.id,
        unitLabel: '1A',
        addressLine: `${MARK} 1A`,
        stage: 'S01_LEAD',
        kwRated: 11.3,
        kwhRated: 15,
        tier: 'UNDERSERVED',
        gridEdge: true,
      },
    });
    made.systemIds.push(system.id);
    await prisma.enrollment.create({ data: { systemId: system.id, program: 'ct_ess' } });
    const resident = await prisma.resident.create({
      data: { systemId: system.id, name: 'C. Mendez', edcAccountName: 'C. Mendez', since: new Date('2026-01-01') },
    });
    await prisma.system.update({ where: { id: system.id }, data: { residentId: resident.id } });

    // S01 → S02 on the qualification snapshot
    const snap = await prisma.qualSnapshot.create({
      data: { systemId: system.id, version: 1, tier: 'UNDERSERVED', itcProfile: { base: 30, dc: 10, ec: 10, li: null } },
    });
    await prisma.system.update({ where: { id: system.id }, data: { currentSnapshotId: snap.id } });
    await onSnapshotWritten(system.id, { edcServed: true });

    // Gates are server-enforced: advancing with an open required item is refused.
    const refusal = await advance(system.id, { via: 'MANUAL', by: 'dod' }).then(() => null, (e) => e as LifecycleError);
    assert.ok(refusal instanceof LifecycleError && refusal.status === 422, 'S02 gate refuses while items are open');

    // X2 — the EDC/IX identity is captured at S02–S04.
    await prisma.system.update({ where: { id: system.id }, data: { edcAccountNo: `${MARK}-EDC`, edcAccountName: 'C. Mendez' } });
    for (const k of ['contact_confirmed', 'name_match_verified']) await applyChecklist(system.id, { key: k, state: 'DONE', by: 'dod' });
    await advance(system.id, { via: 'MANUAL', by: 'dod' });

    // The unit has a label, so it is MFAH and the conditional master-agreement
    // item is part of the S03 gate.
    for (const k of ['esa_signed', 'tc_signed', 'payee_designation', 'master_agmt_verified']) {
      const item = await prisma.checklistItem.findFirst({ where: { systemId: system.id, key: k, state: 'OPEN' } });
      if (item) await applyChecklist(system.id, { key: k, state: 'DONE', by: 'dod' });
    }
    await advance(system.id, { via: 'MANUAL', by: 'dod' });
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).stage, 'S04_APPLIED');

    // X1 — the CGB app number at S04; X2's IX number lands here too.
    await prisma.system.update({ where: { id: system.id }, data: { cgbAppNo: `${MARK}-ESS`, ixAppNo: `${MARK}-IX` } });

    // ROF letter → AUTO S04→S05, rate lock, ITC claim opens
    await logDocument({ systemId: system.id, type: 'ROF_LETTER', title: 'ROF', by: 'dod' });
    const atS05 = await prisma.system.findUniqueOrThrow({ where: { id: system.id } });
    assert.equal(atS05.stage, 'S05_ENTITLED', 'ROF fires S04→S05');
    assert.ok(atS05.lockedRates, 'rates locked at ROF');
    assert.equal((await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: system.id } })).status, 'ACCRUING');

    // X5 — the permit number at S05.
    await prisma.system.update({ where: { id: system.id }, data: { permitNo: `${MARK}-PERMIT` } });
    for (const k of ['permit_approved', 'ix_approved', 'equipment_allocated', 'connection_method_confirmed']) {
      await applyChecklist(system.id, { key: k, state: 'DONE', by: 'dod' });
    }
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).stage, 'S06_SCHEDULED', 'gate-complete fires S05→S06');

    // S06 → S07 on the crew's check-in, through the field surface.
    for (const k of ['crew_assigned', 'resident_confirmed']) await applyChecklist(system.id, { key: k, state: 'DONE', by: 'dod' });
    const wo = await prisma.workOrder.create({
      data: { systemId: system.id, type: 'INSTALL', crewId: crew.id, date: new Date(), status: 'SCHEDULED' },
    });
    await checkIn(wo.id, { lat: 41.02, lng: -73.62 }, 'dod');
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).stage, 'S07_INSTALLED');

    // X3 — Enlighten site + serials at S07.
    const siteId = `${MARK}-SITE`;
    await captureSerials(
      wo.id,
      [0, 1, 2].map((i) => ({ serial: `${MARK}-BAT-${i}`, kind: 'BATTERY', sku: 'IQ10C' })),
      'dod',
    );
    await prisma.equipment.updateMany({ where: { systemId: system.id }, data: { poId: po.id, dom: true } });
    await confirmActivation(wo.id, { enlighten_site_id: siteId, grid_profile: 'IEEE-1547-2018-CT', fw: '7.6.129' }, 'dod');
    await onWorkOrderCheckout(system.id, wo.id, { by: 'dod' });

    const site = await prisma.monitoringSite.create({
      data: { projectId: null, provider: 'Enphase', providerSiteId: siteId, lastSeenAt: new Date() },
    });
    made.siteIds.push(site.id);
    await prisma.telemetrySnapshot.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        monitoringSiteId: site.id, ts: hoursAgo(60 - i), soc: 80, powerKw: 1.1, mode: 'SELF_CONSUMPTION', gridConnected: true,
      })),
    });

    for (const k of ['pre_photos', 'mount_complete', 'collar_set', 'wired_breakered', 'energized_backup_test', 'post_photos', 'serials_scanned', 'enlighten_activated', 'grid_profile_fw', 'comms_verified_both', 'resident_walkthrough']) {
      await applyChecklist(system.id, { key: k, state: 'DONE', by: 'dod' });
    }
    // The machine — not the crew — closes S07.
    await pollFleet([system.id]);
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).stage, 'S08_COMMISSIONED', 'poller confirmed telemetry and closed S07');

    // X4 — the DERMS id at S08.
    await prisma.system.update({ where: { id: system.id }, data: { dermsId: `${MARK}-DERMS` } });
    await pollFleet([system.id]);
    for (const k of ['self_inspection_submitted', 'pto_received', 'cgb_pkg_accepted']) {
      await prisma.checklistItem.updateMany({ where: { systemId: system.id, key: k }, data: { state: 'DONE', doneAt: new Date(), doneBy: 'dod' } });
    }
    await logDocument({ systemId: system.id, type: 'COF_LETTER', title: 'COF', by: 'dod' });

    const operating = await prisma.system.findUniqueOrThrow({ where: { id: system.id } });
    assert.equal(operating.stage, 'OPERATING', 'COF chains S08→S09→OPERATING');

    // every transition in stage_history, in order
    const history = await prisma.stageHistory.findMany({ where: { systemId: system.id }, orderBy: { at: 'asc' } });
    assert.equal(history.length, 9, 'nine transitions recorded');
    assert.deepEqual(
      history.map((h) => `${h.fromStage}→${h.toStage}`),
      STAGE_ORDER.slice(0, 9).map((s, i) => `${s}→${STAGE_ORDER[i + 1]}`),
      'stage_history is the exact locked path',
    );

    // all five external IDs captured
    const X = {
      'X1 cgb_app_no': operating.cgbAppNo,
      'X2 ix_app_no': operating.ixAppNo,
      'X3 enlighten_site_id': operating.enlightenSiteId,
      'X4 derms_id': operating.dermsId,
      'X5 permit_no': operating.permitNo,
    };
    for (const [label, value] of Object.entries(X)) assert.ok(value, `${label} captured`);
    console.log(`     ${Object.entries(X).map(([k, v]) => `${k.split(' ')[0]}=${v!.slice(-6)}`).join(' · ')}`);

    // ══════════════════════════════════════════════════════════════════════
    say(2, 'a dark system raises its own alert, ticket, crew and machine-verified close');
    // ══════════════════════════════════════════════════════════════════════
    await prisma.monitoringSite.update({ where: { id: site.id }, data: { lastSeenAt: hoursAgo(27) } });
    await prisma.telemetrySnapshot.deleteMany({ where: { monitoringSiteId: site.id, ts: { gte: hoursAgo(27) } } });

    await pollFleet([system.id]);
    const alert = await prisma.alert.findFirstOrThrow({ where: { systemId: system.id, ruleKey: 'offline_24h', clearedAt: null } });
    assert.equal(alert.severity, 'FAULT', 'the rule raised a FAULT');
    assert.ok(alert.ticketId, 'the rule opened its own ticket');
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).health, 'FAULT', 'health cache follows');

    const detail = await getTicket(alert.ticketId!);
    assert.ok(detail.installer_of_record, 'installer of record displayed on the ticket');

    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 1);
    await assignTicket(alert.ticketId!, { crewId: crew.id, date: day, by: 'dod' });
    const board = await getBoard(day, 2);
    const cell = board.columns.find((c) => c.crew.id === crew.id)!.days.find((d) => d.day === day.toISOString().slice(0, 10))!;
    assert.ok(cell.cards.length > 0, 'the visit is on the crew day board');

    // closes only on machine-verified telemetry
    await prisma.ticket.update({ where: { id: alert.ticketId! }, data: { state: 'RESOLVED', resolutionCode: 'REMOTE_FIX', resolvedAt: new Date() } });
    assert.equal(await verifyTicket(alert.ticketId!), false, 'no verification without clean telemetry');
    await prisma.telemetrySnapshot.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        monitoringSiteId: site.id, ts: hoursAgo(48 - i), soc: 84, powerKw: 1.2, mode: 'SELF_CONSUMPTION', gridConnected: true,
      })),
    });
    assert.equal(await verifyTicket(alert.ticketId!), true, '48h clean telemetry verifies');
    assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: alert.ticketId! } })).state, 'CLOSED');
    await pollFleet([system.id]);
    // The alert is gone but the booked visit has not happened yet, and
    // 01 §Derived ranks SERVICE above OK — so SERVICE is the honest state.
    assert.equal(
      (await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).health,
      'SERVICE',
      'health drops from FAULT to SERVICE while the visit is still booked',
    );
    await prisma.workOrder.updateMany({
      where: { systemId: system.id, type: 'SERVICE' },
      data: { status: 'COMPLETE', checkinAt: new Date(), checkoutAt: new Date() },
    });
    await pollFleet([system.id]);
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).health, 'OK', 'and to OK once the visit closes');

    // ══════════════════════════════════════════════════════════════════════
    say(3, 'a season closes into PERF_PAY rows; the statement reconciles; variances land on Today');
    // ══════════════════════════════════════════════════════════════════════
    const season = await prisma.season.create({
      data: { name: 'SUMMER', programYear: 2098, window: { start: '2098-06-01', end: '2098-09-30' }, status: 'OPEN' },
    });
    made.seasonId = season.id;

    const second = await prisma.system.create({
      data: {
        propertyId: property.id, unitLabel: '1B', addressLine: `${MARK} 1B`, stage: 'OPERATING',
        kwRated: 11.3, kwhRated: 15, tier: 'UNDERSERVED', cgbAppNo: `${MARK}-ESS-B`,
        cofDate: new Date('2098-01-01'), pisDate: new Date('2098-01-01'), recaptureEnd: new Date('2103-01-01'),
        lockedRates: { annual_rate: 425, enroll_rate: 130, grid_edge: true },
      },
    });
    made.systemIds.push(second.id);

    const csv = [
      'system_id,event_date,window,kw_nominated,kw_delivered',
      `${system.id},2098-07-10,PM1,11.3,10.4`,
      `${system.id},2098-07-24,PM1,11.3,11.0`,
      `${second.id},2098-07-10,PM1,11.3,9.0`,
      `${second.id},2098-07-24,PM1,11.3,9.6`,
    ].join('\n');
    await importEvents(csv, { seasonId: season.id, crossCheck: false, by: 'dod' });

    const closed = await closeSeason(season.id, { by: 'dod' });
    assert.equal(closed.written, 2, 'one PERF_PAY row per system');
    // The rate is whatever was locked at ROF from rate_tables — read it rather
    // than restating it, so the assertion tracks the seed.
    const lockedA = (await prisma.system.findUniqueOrThrow({ where: { id: system.id } })).lockedRates as { annual_rate: number };
    const avgA = (10.4 + 11.0) / 2;
    const expectedA = Number((SEASON_SHARE * lockedA.annual_rate * avgA).toFixed(2));
    const rowA = await prisma.ledgerEntry.findFirstOrThrow({ where: { systemId: system.id, seasonId: season.id, type: 'PERF_PAY' } });
    assert.equal(Number(rowA.expectedAmt), expectedA, 'expected = 0.5 × rate × avg kW');

    const avgB = (9.0 + 9.6) / 2;
    const expectedB = SEASON_SHARE * 425 * avgB; // second system's rate is set explicitly above
    await importStatement(
      ['app_no,amount,paid_date', `${MARK}-ESS,${expectedA},2098-10-15`, `${MARK}-ESS-B,${(expectedB * 0.8).toFixed(2)},2098-10-15`].join('\n'),
      { seasonId: season.id, by: 'dod' },
    );
    const rowB = await prisma.ledgerEntry.findFirstOrThrow({ where: { systemId: second.id, seasonId: season.id, type: 'PERF_PAY' } });
    assert.equal(rowB.status, 'VARIANCE', 'a 20% short payment flips VARIANCE');

    const today = await composeToday();
    assert.ok(
      (today.sections.find((s) => s.key === 'money')?.rows ?? []).some((r) => r.system_id === second.id),
      'the variance lands on Today',
    );

    // ══════════════════════════════════════════════════════════════════════
    say(4, 'a cohort assembles claims and one click produces the diligence ZIP');
    // ══════════════════════════════════════════════════════════════════════
    const claimA = await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: system.id } });
    await prisma.itcClaim.update({
      where: { id: claimA.id },
      data: {
        status: 'BASIS_LOCKED', basisAmt: 9600, totalPct: 50, creditAmt: 4800,
        evidence: { serial_attestations: Object.fromEntries([0, 1, 2].map((i) => [`${MARK}-BAT-${i}`, `att-${i}`])) },
      },
    });
    const claimB = await prisma.itcClaim.create({
      data: { systemId: second.id, status: 'BASIS_LOCKED', basisAmt: 9600, totalPct: 50, creditAmt: 4800, pisDate: second.pisDate, recaptureEnd: second.recaptureEnd },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.equipment.create({
        data: { systemId: second.id, serial: `${MARK}-B-BAT-${i}`, kind: 'BATTERY', sku: 'IQ10C', dom: true, status: 'INSTALLED', poId: po.id, installedAt: new Date() },
      });
    }
    for (const s of [system.id, second.id]) {
      for (const type of ['ROF_LETTER', 'COF_LETTER'] as const) {
        await prisma.document.create({ data: { systemId: s, type, title: type, fileKey: `${MARK}/${s}-${type}.pdf`, status: 'SIGNED', signedAt: new Date() } });
      }
    }

    const cohort = await prisma.itcCohort.create({ data: { label: `${MARK}-Q3`, status: 'ASSEMBLING', priceCents: 92 } });
    made.cohortId = cohort.id;
    const added = await addToCohort(cohort.id, [claimA.id, claimB.id], 'dod');
    assert.equal(added.added.length, 2, 'the quarterly cohort assembles both claims');

    const pack = await assembleDiligencePack(cohort.id, { by: 'dod' });
    const names = listZip(pack.zip);
    assert.ok(names.includes('manifest.json') && names.includes('README.txt'), 'pack is indexed');
    assert.equal(names.filter((n) => n.includes('/attestations/')).length, 6, 'per-serial attestations for both claims');
    assert.equal(names.filter((n) => /\/rof\.pdf/.test(n)).length, 2, 'ROF letter per claim');
    assert.equal(names.filter((n) => /\/cof\.pdf/.test(n)).length, 2, 'COF letter per claim');
    assert.equal(pack.zip.readUInt32LE(0), 0x04034b50, 'a real zip');
    console.log(`     pack: ${names.length} entries · ${pack.gaps.length} gaps reported`);

    // ══════════════════════════════════════════════════════════════════════
    say(5, 'days-in-stage, blocked age and clocks render with zero manual bookkeeping');
    // ══════════════════════════════════════════════════════════════════════
    // days_in_stage comes from stage_history via v_stage_age — never a column.
    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `select column_name from information_schema.columns where table_name='systems'`,
    );
    const names2 = cols.map((c) => c.column_name);
    assert.ok(!names2.includes('days_in_stage'), 'days_in_stage is not stored on systems');
    assert.ok(!names2.includes('blocked_age'), 'blocked age is not stored either');

    const board2 = await getPipelineBoard({ propertyId: property.id });
    const anyCard = board2.columns.flatMap((c) => c.cards)[0];
    if (anyCard) assert.equal(typeof anyCard.days_in_stage, 'number', 'the board reads days-in-stage from the view');

    // blocked age drives the Today row off blocked_at + the code's threshold
    await prisma.system.update({
      where: { id: second.id },
      data: { blockedCode: 'B-DERMS', blockedAt: new Date(Date.now() - 9 * 864e5), stage: 'S08_COMMISSIONED' },
    });
    const today2 = await composeToday();
    const blockedRow = (today2.sections.find((s) => s.key === 'blocked')?.rows ?? []).find((r) => r.system_id === second.id);
    assert.ok(blockedRow, 'a block older than its code threshold surfaces');
    assert.equal(blockedRow!.metric, '9d', 'age computed from blocked_at');
    await prisma.system.update({ where: { id: second.id }, data: { blockedCode: null, blockedAt: null, stage: 'OPERATING' } });

    // every clock evaluates off date fields alone
    const hits = await evaluateClocks(system.id);
    assert.ok(Array.isArray(hits), 'clocks evaluate for the system');
    const rofClock = await prisma.clock.findUniqueOrThrow({ where: { key: 'rof_build' } });
    assert.equal(rofClock.lengthMonths, 24, 'thresholds come from the seed, not the code');

    // ══════════════════════════════════════════════════════════════════════
    say(6, 'turnover: four artifacts close the case and clear the flag');
    // ══════════════════════════════════════════════════════════════════════
    const before = await prisma.resident.count({ where: { systemId: system.id } });
    const moveOut = await reportMoveOut(system.id, {
      reason: 'PM reported move-out',
      newResident: { name: 'A. Okonkwo', edc_account_name: 'A. Okonkwo' },
      by: 'dod',
    });
    assert.ok(moveOut.turnover, 'a case opens');
    assert.ok(moveOut.system.flags.includes('TURNOVER'), 'the TURNOVER flag is set');
    assert.equal(await prisma.resident.count({ where: { systemId: system.id } }), before + 1, 'a resident history row is added, not overwritten');
    const outgoing = await prisma.resident.findFirst({ where: { systemId: system.id, until: { not: null } } });
    assert.ok(outgoing, 'the outgoing occupancy is closed with an until date');

    const open = await listTurnovers();
    const mine = open.find((t) => t.system_id === system.id)!;
    assert.equal(mine.artifacts_on_file, 0, 'four empty slots');
    assert.ok(mine.sla_due, '30-day SLA set');

    for (const [i, key] of TURNOVER_TASKS.entries()) {
      const r = await setTurnoverTask(mine.id, key, key === 'edc_update' || key === 'derms_verify' ? true : `doc-${key}`, 'dod');
      if (i < TURNOVER_TASKS.length - 1) assert.equal(r.complete, false, `${key} filed, case still open`);
      else {
        assert.equal(r.complete, true, 'the fourth artifact closes the case');
        assert.equal(r.flag_cleared, true, 'and clears the flag');
      }
    }
    const after = await prisma.system.findUniqueOrThrow({ where: { id: system.id } });
    assert.ok(!after.flags.includes('TURNOVER'), 'flag gone');
    assert.equal(after.stage, 'OPERATING', 'a move-out is never a stage change');

    console.log('\n✅ Definition-of-done E2E PASSED — all five sentences, plus the turnover loop.');
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
    await prisma.equipment.updateMany({ where: { systemId: { in: ids } }, data: { replacedById: null } });
    await prisma.equipment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.updateMany({ where: { systemId: { in: ids } }, data: { ticketId: null } });
    await prisma.ticket.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.turnoverCase.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.document.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.updateMany({ where: { id: { in: ids } }, data: { currentSnapshotId: null, residentId: null } });
    await prisma.qualSnapshot.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.resident.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (made.siteIds.length) {
    await prisma.telemetrySnapshot.deleteMany({ where: { monitoringSiteId: { in: made.siteIds } } });
    await prisma.monitoringSite.deleteMany({ where: { id: { in: made.siteIds } } });
  }
  if (made.cohortId) {
    await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: made.cohortId } });
    await prisma.itcCohort.deleteMany({ where: { id: made.cohortId } });
  }
  if (made.seasonId) {
    await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: made.seasonId } });
    await prisma.season.deleteMany({ where: { id: made.seasonId } });
  }
  if (made.poId) await prisma.purchaseOrder.deleteMany({ where: { id: made.poId } });
  if (made.crewId) await prisma.crew.deleteMany({ where: { id: made.crewId } });
  if (made.installerId) await prisma.installer.deleteMany({ where: { id: made.installerId } });
  await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: { in: ['events_import', 'statement'] } } });
  if (made.propertyId) await prisma.property.deleteMany({ where: { id: made.propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ DoD E2E FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
