/**
 * Lifecycle state-machine integration test (P2 acceptance). Drives ONE fresh
 * system S01 → OPERATING purely through the public lib/lifecycle surface — the
 * same functions the routes, pollers, and field app call — then asserts:
 *   • stage_history has all nine forward rows
 *   • locked_rates written at ROF, ITC claim ACCRUING at S05 → BASIS_LOCKED at OP
 *   • ENROLL_INC ledger row booked, installer_of_record snapshot present
 *   • a second run of each AUTO trigger is a no-op (idempotent guard)
 *   • GET /api/lifecycle/map content matches the seed tables
 *
 * Self-cleaning: everything it creates is deleted in a finally block. Run with a
 * seeded DB (npx ts-node src/scripts/seed-lifecycle.ts first):
 *   npx ts-node src/scripts/lifecycle.e2e.ts
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import {
  advance,
  applyChecklist,
  logDocument,
  onSnapshotWritten,
  onRofLogged,
  onCofLogged,
  onWorkOrderCheckin,
  onWorkOrderCheckout,
  onTelemetryConfirmed,
  buildLifecycleMap,
  STAGE_ORDER,
  TRANSITIONS,
} from '../lib/lifecycle';

const MARK = `E2E-${Date.now()}`;

async function stageOf(id: string) {
  const s = await prisma.system.findUniqueOrThrow({ where: { id } });
  return s.stage;
}

async function markDone(systemId: string, keys: string[]) {
  for (const key of keys) {
    await applyChecklist(systemId, { key, state: 'DONE', by: 'e2e' });
  }
}

async function run() {
  // ---- setup: a fresh property + system at S01 ------------------------------
  const property = await prisma.property.create({
    data: {
      address: `${MARK} 1 Test St`,
      town: 'Hartford',
      postalCode: '06101',
      county: 'Hartford',
      lat: 41.76,
      lng: -72.68,
    },
  });
  const installer = await prisma.installer.create({ data: { orgName: `${MARK} Installer`, selfPerform: true } });
  const crew = await prisma.crew.create({
    data: { installerId: installer.id, label: 'Crew A', members: [{ name: 'Lead Tech', license: 'E1-123' }] },
  });

  const system = await prisma.system.create({
    data: {
      propertyId: property.id,
      addressLine: `${MARK} 1 Test St, Hartford CT`,
      stage: 'S01_LEAD',
      kwRated: 15,
      kwhRated: 15,
      gridEdge: true,
      tier: 'STANDARD',
    },
  });
  const id = system.id;
  await prisma.enrollment.create({ data: { systemId: id, program: 'ct_ess' } });

  try {
    // ---- S01 → S02: snapshot written --------------------------------------
    const snap = await prisma.qualSnapshot.create({
      data: { systemId: id, version: 1, tier: 'STANDARD', itcProfile: { base: 30, dc: 0, ec: 0, li: null } },
    });
    await prisma.system.update({ where: { id }, data: { currentSnapshotId: snap.id } });
    await onSnapshotWritten(id, { edcServed: true });
    assert.equal(await stageOf(id), 'S02_QUALIFIED', 'S01→S02 on snapshot');

    // ---- S02 → S03: MANUAL after S02 checklist ----------------------------
    await markDone(id, ['contact_confirmed', 'name_match_verified']);
    await advance(id, { via: 'MANUAL', by: 'e2e' });
    assert.equal(await stageOf(id), 'S03_COMMITTED', 'S02→S03 manual');

    // conditional master_agmt_verified must be NA for a single-family unit
    const masterItem = await prisma.checklistItem.findFirst({ where: { systemId: id, key: 'master_agmt_verified' } });
    assert.equal(masterItem?.state, 'NA', 'MFAH-only item instantiated NA');

    // ---- S03 → S04: MANUAL after signatures -------------------------------
    await markDone(id, ['esa_signed', 'tc_signed', 'payee_designation']);
    await advance(id, { via: 'MANUAL', by: 'e2e' });
    assert.equal(await stageOf(id), 'S04_APPLIED', 'S03→S04 manual');

    // cgb_app_submitted is held until the 3-business-day ESA cancellation window
    // closes (02 §S03→S04); the ESA was signed moments ago, so a DONE is refused.
    await assert.rejects(
      () => applyChecklist(id, { key: 'cgb_app_submitted', state: 'DONE', by: 'e2e' }),
      /TASK_HELD|held until/,
      'cgb_app_submitted refuses DONE inside the cancellation window',
    );
    // Backdate the ESA past the window (5 calendar days clears 3 business days) — now it takes.
    await prisma.checklistItem.updateMany({
      where: { systemId: id, key: 'esa_signed' },
      data: { doneAt: new Date(Date.now() - 5 * 864e5) },
    });
    await applyChecklist(id, { key: 'cgb_app_submitted', state: 'DONE', by: 'e2e' });
    const cgb = await prisma.checklistItem.findFirst({ where: { systemId: id, key: 'cgb_app_submitted' } });
    assert.equal(cgb?.state, 'DONE', 'cgb_app_submitted completes once the window has closed');

    // ---- S04 → S05: AUTO on ROF letter ------------------------------------
    await logDocument({ systemId: id, type: 'ROF_LETTER', title: 'ROF', by: 'e2e' });
    assert.equal(await stageOf(id), 'S05_ENTITLED', 'S04→S05 auto on ROF');

    const atS05 = await prisma.system.findUniqueOrThrow({ where: { id } });
    const locked = atS05.lockedRates as { annual_rate: number; enroll_rate: number; grid_edge: boolean } | null;
    assert.ok(locked, 'locked_rates written at ROF');
    assert.equal(locked?.enroll_rate, 130, 'grid-edge enroll rate locked at 130');
    assert.equal(locked?.annual_rate, 200, 'STANDARD 2026 annual rate locked');
    assert.ok(atS05.rofDeadline, 'rof_deadline = rof + 24mo written');
    const claimAtS05 = await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: id } });
    assert.equal(claimAtS05.status, 'ACCRUING', 'ITC claim opened ACCRUING at S05');

    // ---- S05 → S06: AUTO when the four required items are DONE -------------
    await markDone(id, ['permit_approved', 'ix_approved', 'equipment_allocated', 'connection_method_confirmed']);
    assert.equal(await stageOf(id), 'S06_SCHEDULED', 'S05→S06 auto on gate complete');

    // ---- S06 → S07: AUTO on INSTALL work-order check-in -------------------
    await markDone(id, ['crew_assigned', 'resident_confirmed']);
    const wo = await prisma.workOrder.create({
      data: { systemId: id, type: 'INSTALL', crewId: crew.id, date: new Date(), status: 'SCHEDULED' },
    });
    await onWorkOrderCheckin(id, wo.id);
    assert.equal(await stageOf(id), 'S07_INSTALLED', 'S06→S07 auto on WO check-in');

    // check-out snapshots installer_of_record (L6)
    await onWorkOrderCheckout(id, wo.id);
    const afterCheckout = await prisma.system.findUniqueOrThrow({ where: { id } });
    const ior = afterCheckout.installerOfRecord as { work_order_id: string; installer_org: string } | null;
    assert.ok(ior, 'installer_of_record written at check-out');
    assert.equal(ior?.work_order_id, wo.id, 'installer_of_record points at the INSTALL WO');

    // ---- S07 → S08: AUTO on field checklist 100% ∧ telemetry --------------
    await markDone(id, [
      'pre_photos', 'mount_complete', 'collar_set', 'wired_breakered', 'energized_backup_test',
      'post_photos', 'serials_scanned', 'enlighten_activated', 'grid_profile_fw', 'comms_verified_both',
      'resident_walkthrough',
    ]);
    // telemetry_confirmed is auto-only — a hand PATCH must be refused
    await assert.rejects(
      () => applyChecklist(id, { key: 'telemetry_confirmed', state: 'DONE', by: 'e2e' }),
      /AUTO_ONLY|machine/,
      'telemetry_confirmed rejects a manual PATCH',
    );
    assert.equal(await stageOf(id), 'S07_INSTALLED', 'still S07 until the poller confirms telemetry');
    await onTelemetryConfirmed(id);
    assert.equal(await stageOf(id), 'S08_COMMISSIONED', 'S07→S08 auto on telemetry');

    // self-inspection auto-submitted on S08 entry
    const selfInspect = await prisma.checklistItem.findFirst({ where: { systemId: id, key: 'self_inspection_submitted' } });
    assert.equal(selfInspect?.state, 'DONE', 'self_inspection_submitted auto-DONE on S08 entry');

    // ---- S08 → S09 → OPERATING: AUTO chain on COF letter ------------------
    await logDocument({ systemId: id, type: 'COF_LETTER', title: 'COF', by: 'e2e' });
    assert.equal(await stageOf(id), 'OPERATING', 'S08→S09→OPERATING chained on COF');

    const op = await prisma.system.findUniqueOrThrow({ where: { id } });
    assert.ok(op.pisDate, 'pis_date set at OPERATING');
    assert.ok(op.recaptureEnd, 'recapture_end = pis + 60mo');
    assert.ok(op.termEnd, 'term_end = cof + 120mo');

    const claimOp = await prisma.itcClaim.findUniqueOrThrow({ where: { systemId: id } });
    assert.equal(claimOp.status, 'BASIS_LOCKED', 'ITC claim → BASIS_LOCKED at OPERATING');
    assert.ok(claimOp.pisDate, 'claim pis_date set');
    const basisLines = await prisma.itcBasisLine.count({ where: { claimId: claimOp.id } });
    assert.ok(basisLines >= 1, 'basis line(s) sourced');

    const enroll = await prisma.ledgerEntry.findMany({ where: { systemId: id, type: 'ENROLL_INC' } });
    assert.equal(enroll.length, 1, 'exactly one ENROLL_INC ledger row');
    assert.equal(Number(enroll[0].expectedAmt), 130 * 15, 'ENROLL_INC = enroll_rate × kWh');

    // ---- stage_history: all nine forward rows -----------------------------
    const history = await prisma.stageHistory.findMany({ where: { systemId: id }, orderBy: { at: 'asc' } });
    assert.equal(history.length, 9, 'nine stage_history rows S01→OPERATING');
    assert.deepEqual(
      history.map((h) => `${h.fromStage}→${h.toStage}`),
      STAGE_ORDER.slice(0, 9).map((s, i) => `${s}→${STAGE_ORDER[i + 1]}`),
      'history is the exact locked path',
    );

    // ---- idempotency: a second AUTO fire changes nothing -------------------
    await onTelemetryConfirmed(id);
    await onCofLogged(id);
    await onRofLogged(id);
    await onWorkOrderCheckin(id, wo.id);
    const history2 = await prisma.stageHistory.count({ where: { systemId: id } });
    assert.equal(history2, 9, 'duplicate AUTO fires add no stage_history rows');
    assert.equal(await stageOf(id), 'OPERATING', 'still OPERATING after replays');
    assert.equal(await prisma.ledgerEntry.count({ where: { systemId: id, type: 'ENROLL_INC' } }), 1, 'no duplicate ledger row');
    assert.equal(await prisma.itcClaim.count({ where: { systemId: id } }), 1, 'no duplicate claim');

    // ---- GET /api/lifecycle/map matches the seed tables -------------------
    await assertMapMatchesSeeds();

    console.log('\n✅ lifecycle e2e PASSED — S01→OPERATING through the public surface, idempotent, map matches seeds.');
  } finally {
    await cleanup(id, property.id, crew.id, installer.id);
  }
}

async function assertMapMatchesSeeds() {
  const map = await buildLifecycleMap();

  // transitions constant round-trips verbatim
  assert.deepEqual(map.transitions, TRANSITIONS, 'map.transitions === TRANSITIONS');

  // clocks: count + keys match the seed table
  const clockKeys = (await prisma.clock.findMany({ select: { key: true } })).map((c) => c.key).sort();
  assert.deepEqual(map.clocks.map((c) => c.key).sort(), clockKeys, 'map clocks match seed clocks');

  // per-stage gate + block-code content matches checklist_templates / blocked_codes
  for (const stage of STAGE_ORDER) {
    const entry = map.stages.find((s) => s.stage === stage);
    assert.ok(entry, `map has stage ${stage}`);

    const seedItems = await prisma.checklistTemplate.findMany({ where: { stage }, orderBy: { sort: 'asc' } });
    assert.deepEqual(
      entry!.gate.map((g) => g.key),
      seedItems.map((t) => t.key),
      `${stage} gate items match checklist_templates (order + set)`,
    );

    const seedCodes = await prisma.blockedCode.findMany({ where: { stage }, orderBy: { code: 'asc' } });
    assert.deepEqual(
      entry!.block_codes.map((b) => b.code).sort(),
      seedCodes.map((c) => c.code).sort(),
      `${stage} block codes match blocked_codes`,
    );
  }

  // spot-check the two gates the doc pins exactly
  const s05 = map.stages.find((s) => s.stage === 'S05_ENTITLED')!;
  assert.deepEqual(
    s05.gate.map((g) => g.key).sort(),
    ['connection_method_confirmed', 'equipment_allocated', 'ix_approved', 'permit_approved'],
    'S05 gate is the four locked items',
  );
  const s07 = map.stages.find((s) => s.stage === 'S07_INSTALLED')!;
  assert.ok(s07.gate.some((g) => g.key === 'telemetry_confirmed' && g.auto_only), 'S07 includes auto-only telemetry_confirmed');
}

async function cleanup(systemId: string, propertyId: string, crewId: string, installerId: string) {
  const claim = await prisma.itcClaim.findUnique({ where: { systemId } });
  if (claim) await prisma.itcBasisLine.deleteMany({ where: { claimId: claim.id } });
  await prisma.itcClaim.deleteMany({ where: { systemId } });
  await prisma.ledgerEntry.deleteMany({ where: { systemId } });
  await prisma.checklistItem.deleteMany({ where: { systemId } });
  await prisma.stageHistory.deleteMany({ where: { systemId } });
  await prisma.document.deleteMany({ where: { systemId } });
  await prisma.workOrder.deleteMany({ where: { systemId } });
  await prisma.turnoverCase.deleteMany({ where: { systemId } });
  await prisma.enrollment.deleteMany({ where: { systemId } });
  await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: systemId } });
  await prisma.system.update({ where: { id: systemId }, data: { currentSnapshotId: null } });
  await prisma.qualSnapshot.deleteMany({ where: { systemId } });
  await prisma.system.deleteMany({ where: { id: systemId } });
  await prisma.crew.deleteMany({ where: { id: crewId } });
  await prisma.installer.deleteMany({ where: { id: installerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ lifecycle e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
