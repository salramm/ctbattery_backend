/**
 * Pipeline / Property / Deals integration test (P4 acceptance). Builds one
 * account + one multi-unit property through the public lifecycle surface, then
 * asserts:
 *   • an unmet gate refuses `advance` with the unmet list, and the board card
 *     carries that same list (so the drop handler renders the server's verdict)
 *   • a batch action across the property's units reports mixed per-unit results
 *   • the release meter matches the unit stages
 *   • the inventory summary matches a direct equipment / purchase_orders query
 *
 * Self-cleaning: everything it creates is removed in a finally block. The
 * lifecycle demo property itself lands in P10 — this fixture is test-only.
 *
 *   npx ts-node src/scripts/pipeline.e2e.ts
 */
import assert from 'node:assert/strict';
import type { Stage } from '@prisma/client';
import prisma from '../config/database';
import { advance, applyChecklist, logDocument, onSnapshotWritten, LifecycleError, STAGE_ORDER } from '../lib/lifecycle';
import { getBoard } from '../services/pipeline.service';
import { getProperty, runBatch, getBatchCounts } from '../services/property.service';
import { listDeals } from '../services/accounts.service';
import { getInventorySummary, BOM } from '../services/inventory.service';

const MARK = `P4E2E-${Date.now()}`;
const created = { systemIds: [] as string[], propertyId: '', accountId: '' };

/** Walk a fresh unit up to `target` through the engine, so its checklists are real. */
async function seedUnit(propertyId: string, unitLabel: string, target: Stage): Promise<string> {
  const system = await prisma.system.create({
    data: {
      propertyId,
      unitLabel,
      addressLine: `${MARK} ${unitLabel}`,
      stage: 'S01_LEAD',
      kwRated: 15,
      kwhRated: 15,
      gridEdge: true,
      tier: 'STANDARD',
      source: 'batch',
    },
  });
  created.systemIds.push(system.id);
  await prisma.enrollment.create({ data: { systemId: system.id, program: 'ct_ess' } });

  const want = STAGE_ORDER.indexOf(target);
  if (want <= STAGE_ORDER.indexOf('S01_LEAD')) return system.id;

  const snap = await prisma.qualSnapshot.create({
    data: { systemId: system.id, version: 1, tier: 'STANDARD', itcProfile: { base: 30, dc: 0, ec: 10, li: null } },
  });
  await prisma.system.update({ where: { id: system.id }, data: { currentSnapshotId: snap.id } });
  await onSnapshotWritten(system.id, { edcServed: true });
  if (want <= STAGE_ORDER.indexOf('S02_QUALIFIED')) return system.id;

  for (const k of ['contact_confirmed', 'name_match_verified']) {
    await applyChecklist(system.id, { key: k, state: 'DONE', by: 'e2e' });
  }
  await advance(system.id, { via: 'MANUAL', by: 'e2e' });
  if (want <= STAGE_ORDER.indexOf('S03_COMMITTED')) return system.id;

  // These units are MFAH (unit label + portfolio account), so the conditional
  // master_agmt_verified item is live and part of the S03 gate.
  for (const k of ['esa_signed', 'tc_signed', 'payee_designation', 'master_agmt_verified']) {
    const item = await prisma.checklistItem.findFirst({ where: { systemId: system.id, key: k, state: 'OPEN' } });
    if (item) await applyChecklist(system.id, { key: k, state: 'DONE', by: 'e2e' });
  }
  await advance(system.id, { via: 'MANUAL', by: 'e2e' });
  if (want <= STAGE_ORDER.indexOf('S04_APPLIED')) return system.id;

  await logDocument({ systemId: system.id, type: 'ROF_LETTER', title: 'ROF', by: 'e2e' });
  return system.id;
}

/** Sign a parked S03 unit's agreements, optionally leaving one item open. */
async function completeS03(systemId: string, except?: string) {
  for (const k of ['esa_signed', 'tc_signed', 'payee_designation', 'master_agmt_verified']) {
    if (k === except) continue;
    const item = await prisma.checklistItem.findFirst({ where: { systemId, key: k, state: 'OPEN' } });
    if (item) await applyChecklist(systemId, { key: k, state: 'DONE', by: 'e2e' });
  }
}

/** Push a unit's ESA signature into the past so the cgb hold has expired. */
async function clearCancelWindow(systemId: string) {
  await prisma.checklistItem.updateMany({
    where: { systemId, key: 'esa_signed' },
    data: { doneAt: new Date(Date.now() - 7 * 864e5) },
  });
}

async function run() {
  const account = await prisma.account.create({
    data: { type: 'OWNER', name: `${MARK} Holdings`, dealState: 'D6_RELEASING', notes: 'PM distributing resident ESAs' },
  });
  created.accountId = account.id;
  const property = await prisma.property.create({
    data: {
      accountId: account.id,
      name: `${MARK} Commons`,
      address: `${MARK} 10 Batch St`,
      town: 'Hartford',
      postalCode: '06101',
      county: 'Hartford',
    },
  });
  created.propertyId = property.id;

  try {
    // ---- units across stages ------------------------------------------------
    const u1A = await seedUnit(property.id, '1A', 'S04_APPLIED'); // cgb submits cleanly
    const u1B = await seedUnit(property.id, '1B', 'S03_COMMITTED'); // signatures complete → advances then submits
    const u1C = await seedUnit(property.id, '1C', 'S03_COMMITTED'); // will be missing a signature
    const u1D = await seedUnit(property.id, '1D', 'S03_COMMITTED'); // will be blocked
    await seedUnit(property.id, '1E', 'S02_QUALIFIED'); // not eligible for the CGB batch
    await seedUnit(property.id, '2A', 'S05_ENTITLED'); // past applied; counts in the meter

    // Units parked at S03 sign their agreements here — except 1C, which is
    // missing its T&C (the classic "skipped: missing T&C" row).
    await completeS03(u1B);
    await completeS03(u1C, 'tc_signed');
    await completeS03(u1D);
    // 1D is blocked at its current stage.
    await prisma.system.update({ where: { id: u1D }, data: { blockedCode: 'B-SIG', blockedAt: new Date() } });
    // 1A and 1B have waited out the ESA cancellation window; 1C/1D have not.
    await clearCancelWindow(u1A);
    await clearCancelWindow(u1B);

    // ---- gate refusal is the server's word, and the card carries it ---------
    const board = await getBoard({ propertyId: property.id });
    const s03 = board.columns.find((c) => c.stage === 'S03_COMMITTED')!;
    const card1C = s03.cards.find((c) => c.id === u1C)!;
    assert.ok(card1C, '1C sits in the S03 column');
    assert.deepEqual(
      card1C.unmet.map((u) => u.key),
      ['tc_signed'],
      'board card carries the server-computed unmet list',
    );

    const refusal = await advance(u1C, { via: 'MANUAL', by: 'e2e' }).then(
      () => null,
      (e) => e as LifecycleError,
    );
    assert.ok(refusal instanceof LifecycleError, 'advance past an unmet gate throws');
    assert.equal(refusal!.status, 422, 'refusal is a 422');
    assert.equal(refusal!.code, 'GATE_UNMET', 'refusal code');
    assert.deepEqual(
      (refusal!.payload?.unmet as Array<{ key: string }>).map((u) => u.key),
      card1C.unmet.map((u) => u.key),
      'the 422 unmet list is exactly what the card showed — the board never guesses',
    );
    assert.equal(
      (await prisma.system.findUniqueOrThrow({ where: { id: u1C } })).stage,
      'S03_COMMITTED',
      'refused unit did not move (the card snaps back)',
    );

    // blocked cards carry their code
    const card1D = s03.cards.find((c) => c.id === u1D)!;
    assert.equal(card1D.blocked_code, 'B-SIG', 'blocked card carries its code');

    // S08 4-dot tracker shape + pill anatomy
    assert.ok(card1C.pills.includes('GE') && card1C.pills.includes('EC'), 'pills render GE + EC');
    assert.equal(typeof card1C.days_in_stage, 'number', 'v_stage_age drives days-in-stage');
    assert.ok(board.columns.some((c) => c.stage === 'S09_LIVE' && c.momentary), 'S09 renders as the momentary column');
    assert.equal(board.columns.length, 9, 'nine columns');

    // ---- batch: mixed per-unit results -------------------------------------
    const counts = await getBatchCounts(property.id);
    assert.equal(counts.submit_cgb_apps, 4, 'four units eligible for Submit CGB apps (1A,1B,1C,1D)');

    const batch = await runBatch(property.id, 'submit_cgb_apps', undefined, 'e2e');
    assert.equal(batch.eligible, 4, 'batch acted only on eligible units');
    assert.equal(batch.results.length, 4, 'every touched unit is reported');
    assert.ok(batch.applied >= 1 && batch.skipped >= 1, `mixed results: ${batch.applied} applied / ${batch.skipped} skipped`);

    const byUnit = new Map(batch.results.map((r) => [r.unit_label, r]));
    assert.equal(byUnit.get('1A')!.result, 'applied', '1A submitted');
    assert.equal(byUnit.get('1B')!.result, 'applied', '1B advanced S03→S04 then submitted');
    assert.equal(byUnit.get('1C')!.result, 'skipped', '1C skipped');
    assert.match(byUnit.get('1C')!.detail, /tc_signed|T&C|unmet/i, '1C reason names the missing signature');
    assert.equal(byUnit.get('1D')!.result, 'skipped', '1D skipped');
    assert.match(byUnit.get('1D')!.detail, /B-SIG/, '1D reason names its block code');
    assert.ok(!byUnit.has('1E'), 'ineligible stage never reported');
    console.log(`  batch → ${batch.applied} submitted · ${batch.skipped} skipped: ` +
      batch.results.filter((r) => r.result === 'skipped').map((r) => `${r.unit_label} — ${r.detail}`).join(' · '));

    // ---- release meter matches the unit stages ------------------------------
    const detail = await getProperty(property.id);
    const units = await prisma.system.findMany({ where: { propertyId: property.id, terminalState: null } });
    const idx = (s: Stage) => STAGE_ORDER.indexOf(s);
    assert.equal(detail.release_meter.units, 6, 'six units');
    assert.equal(
      detail.release_meter.applied,
      units.filter((u) => idx(u.stage) >= idx('S04_APPLIED')).length,
      'release meter Applied matches unit stages',
    );
    assert.equal(
      detail.release_meter.rof,
      units.filter((u) => u.rofDate != null).length,
      'release meter ROF matches rof_date',
    );
    assert.equal(detail.release_meter.blocked, 1, 'one blocked unit');
    assert.equal(
      detail.release_meter.by_stage.reduce((n, s) => n + s.count, 0),
      units.length,
      'by-stage counts sum to the active units',
    );
    assert.equal(detail.property.account?.deal_state, 'D6_RELEASING', 'property header carries the deal state');
    assert.equal(detail.units.length, 6, 'unit grid renders every unit');

    // ---- deals sub-tab ------------------------------------------------------
    const deals = await listDeals();
    const mine = deals.find((d) => d.id === account.id)!;
    assert.ok(mine, 'account appears in the deals list');
    assert.equal(mine.deal_state, 'D6_RELEASING', 'D-state chip');
    assert.equal(mine.units, 6, 'unit count rolls up from the property');
    assert.equal(mine.release.blocked, 1, 'release roll-up counts the blocked unit');

    // ---- inventory summary vs a direct query -------------------------------
    const inv = await getInventorySummary();
    for (const item of BOM) {
      const [available, allocated] = await Promise.all([
        prisma.equipment.count({ where: { status: 'IN_STOCK', OR: [{ sku: item.sku }, { sku: null, kind: item.kind }] } }),
        prisma.equipment.count({ where: { status: 'ALLOCATED', OR: [{ sku: item.sku }, { sku: null, kind: item.kind }] } }),
      ]);
      const row = inv.skus.find((s) => s.sku === item.sku)!;
      assert.equal(row.available, available, `${item.sku} available matches a direct query`);
      assert.equal(row.allocated, allocated, `${item.sku} allocated matches a direct query`);
      assert.equal(row.on_hand, available + allocated, `${item.sku} on_hand = available + allocated`);
    }
    const expectedBuildable = Math.min(
      ...(await Promise.all(
        BOM.map(async (item) =>
          Math.floor(
            (await prisma.equipment.count({
              where: { status: 'IN_STOCK', OR: [{ sku: item.sku }, { sku: null, kind: item.kind }] },
            })) / item.qty_per_system,
          ),
        ),
      )),
    );
    assert.equal(inv.buildable, expectedBuildable, 'buildable = min(floor(available / qty_per_system))');
    const openPo = await prisma.purchaseOrder.findFirst({
      where: { status: { in: ['ORDERED', 'PARTIAL'] } },
      orderBy: { dueAt: 'asc' },
    });
    assert.equal(inv.next_po?.po_no ?? null, openPo?.poNo ?? null, 'next open PO matches a direct query');

    console.log(`  inventory → buildable ${inv.buildable} · constraint ${inv.constraint_sku} · next PO ${inv.next_po?.po_no ?? '—'}`);
    console.log('\n✅ pipeline/property/deals e2e PASSED');
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  const ids = created.systemIds;
  if (ids.length) {
    await prisma.itcBasisLine.deleteMany({ where: { claim: { systemId: { in: ids } } } });
    await prisma.itcClaim.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.document.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.turnoverCase.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.updateMany({ where: { id: { in: ids } }, data: { currentSnapshotId: null } });
    await prisma.qualSnapshot.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (created.propertyId) {
    await prisma.activityLog.deleteMany({ where: { entity: 'property', entityId: created.propertyId } });
    await prisma.document.deleteMany({ where: { propertyId: created.propertyId } });
    await prisma.property.deleteMany({ where: { id: created.propertyId } });
  }
  if (created.accountId) {
    await prisma.accountContact.deleteMany({ where: { accountId: created.accountId } });
    await prisma.account.deleteMany({ where: { id: created.accountId } });
  }
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ pipeline e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
