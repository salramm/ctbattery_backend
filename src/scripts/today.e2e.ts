/**
 * Today queue + clock engine integration test (P6 acceptance).
 *
 * Seeds one fixture per section, asserts each produces at least one row with
 * the right primary action, then clears every underlying condition and asserts
 * the next compose drops the rows — the queue is a live read, never a cache.
 * Also covers the clock engine directly: warn-threshold parsing from the seed,
 * and the once-only crossing guard.
 *
 * Self-cleaning.  npx ts-node src/scripts/today.e2e.ts
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import { composeToday, todayBlock, type TodaySection } from '../services/today.service';
import { evaluateClocks, sweepClocks, warnDate, addDays, addMonths } from '../lib/lifecycle';

const MARK = `P6E2E-${Date.now()}`;
const made = {
  systemIds: [] as string[],
  propertyId: '',
  alertId: '',
  docId: '',
  ledgerId: '',
  turnoverId: '',
  enrollmentIds: [] as string[],
};

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);

function section(t: Awaited<ReturnType<typeof composeToday>>, key: string): TodaySection | undefined {
  return t.sections.find((s) => s.key === key);
}

async function makeSystem(label: string, data: Record<string, unknown> = {}) {
  const s = await prisma.system.create({
    data: {
      propertyId: made.propertyId,
      unitLabel: label,
      addressLine: `${MARK} ${label}`,
      stage: 'S05_ENTITLED',
      kwRated: 15,
      kwhRated: 15,
      ...data,
    },
  });
  made.systemIds.push(s.id);
  return s;
}

async function run() {
  const property = await prisma.property.create({
    data: { address: `${MARK} 1 Queue St`, town: 'Hartford', postalCode: '06101', county: 'Hartford' },
  });
  made.propertyId = property.id;

  try {
    // ---- clock-engine unit checks: thresholds come from the seed prose -----
    const start = new Date('2026-01-01T00:00:00Z');
    assert.deepEqual(warnDate(start, null, '18 mo'), addMonths(start, 18), '"18 mo" → start + 18 months');
    assert.deepEqual(warnDate(start, null, 'day 14'), addDays(start, 14), '"day 14" → start + 14 days');
    const close = new Date('2026-08-07T00:00:00Z');
    assert.deepEqual(warnDate(start, close, '60 d before close'), addDays(close, -60), '"60 d before close" → due - 60d');
    assert.equal(warnDate(start, null, 'on removal intent'), null, 'event-driven clocks schedule no warning');
    assert.equal(warnDate(start, null, null), null, 'no warn_at → no warning');

    // ---- section 1: health alert (FAULT, no ticket → [Open ticket]) --------
    const alertSys = await makeSystem('A1', { stage: 'OPERATING', health: 'FAULT' });
    const alert = await prisma.alert.create({
      data: { systemId: alertSys.id, ruleKey: 'offline_24h', severity: 'FAULT', openedAt: daysAgo(2) },
    });
    made.alertId = alert.id;

    // ---- section 2: blocked past its code's today_after_days --------------
    // B-DERMS carries today_after_days = 7, so 9 days in it must surface.
    const code = await prisma.blockedCode.findUniqueOrThrow({ where: { code: 'B-DERMS' } });
    assert.equal(code.todayAfterDays, 7, 'B-DERMS seeds a 7-day Today threshold');
    const blockedSys = await makeSystem('B1', {
      stage: 'S08_COMMISSIONED',
      blockedCode: 'B-DERMS',
      blockedAt: daysAgo(9),
      blockedNote: 'not visible in EnergyHub',
    });
    // A second block that has NOT aged past its threshold must stay out.
    const freshBlocked = await makeSystem('B2', {
      stage: 'S08_COMMISSIONED',
      blockedCode: 'B-DERMS',
      blockedAt: daysAgo(2),
    });

    // ---- section 3: deadline countdown (ROF build window, past 18 mo) -----
    const clockSys = await makeSystem('C1', { rofDate: addMonths(new Date(), -20) });

    // a second clock source with a different resolver: turnover SLA, warn day 14
    const turnSys = await makeSystem('C2', { stage: 'OPERATING' });
    const turnover = await prisma.turnoverCase.create({
      data: { systemId: turnSys.id, openedAt: daysAgo(20), slaDue: addDays(daysAgo(20), 30) },
    });
    made.turnoverId = turnover.id;

    // ---- section 4: signature out > 48h ------------------------------------
    const sigSys = await makeSystem('D1', { stage: 'S03_COMMITTED' });
    const doc = await prisma.document.create({
      data: {
        systemId: sigSys.id,
        type: 'ESA',
        title: 'Resident ESA',
        envelopeId: 'env-p6-0001',
        status: 'SENT',
        createdAt: daysAgo(3),
      },
    });
    made.docId = doc.id;

    // ---- section 5: money variance ----------------------------------------
    const moneySys = await makeSystem('E1', { stage: 'OPERATING' });
    const ledger = await prisma.ledgerEntry.create({
      data: {
        systemId: moneySys.id,
        type: 'PERF_PAY',
        status: 'VARIANCE',
        expectedAmt: 1200,
        receivedAmt: 900,
        expectedDate: daysAgo(10),
      },
    });
    made.ledgerId = ledger.id;

    // ---- compose: every section present, one action per row ---------------
    const today = await composeToday();
    for (const key of ['health', 'blocked', 'deadlines', 'signatures', 'money']) {
      const s = section(today, key);
      assert.ok(s && s.rows.length > 0, `section ${key} has at least one row`);
    }
    assert.equal(today.sections.length, 5, 'all five sections present with fixtures in place');
    assert.deepEqual(
      today.sections.map((s) => s.key),
      ['health', 'blocked', 'deadlines', 'signatures', 'money'],
      'sections come back in priority order',
    );
    for (const s of today.sections) {
      for (const row of s.rows) {
        assert.ok(row.action && row.action.label, `${s.key} row carries exactly one primary action`);
        assert.ok(row.action.href || row.action.endpoint, `${s.key} action goes somewhere`);
      }
    }

    // correct actions per 03 §Today
    const health = section(today, 'health')!.rows.find((r) => r.system_id === alertSys.id)!;
    assert.equal(health.action.label, 'Open ticket', 'untracked alert offers [Open ticket]');
    assert.equal(health.severity, 'FAULT', 'FAULT severity carried');

    const blockedRows = section(today, 'blocked')!.rows;
    assert.ok(blockedRows.some((r) => r.system_id === blockedSys.id), 'aged block surfaces');
    assert.ok(!blockedRows.some((r) => r.system_id === freshBlocked.id), 'block younger than today_after_days stays out');
    assert.equal(blockedRows.find((r) => r.system_id === blockedSys.id)!.action.label, 'Open', 'blocked row offers [Open]');

    const deadlines = section(today, 'deadlines')!.rows;
    const clockRow = deadlines.find((r) => r.system_id === clockSys.id)!;
    assert.ok(clockRow, 'ROF build window past 18 mo surfaces');
    assert.equal(clockRow.label, 'ROF build window');
    assert.match(clockRow.metric, /left|over/, 'countdown metric reads as a countdown');

    const turnRow = deadlines.find((r) => r.system_id === turnSys.id)!;
    assert.ok(turnRow, 'turnover SLA past day 14 surfaces');
    assert.equal(turnRow.label, 'Turnover SLA');
    assert.equal(turnRow.action.label, 'Open', 'turnover row offers [Open]');

    const sigRow = section(today, 'signatures')!.rows.find((r) => r.system_id === sigSys.id)!;
    assert.equal(sigRow.action.label, 'Resend', 'a 3-day-old envelope offers [Resend]');

    const moneyRow = section(today, 'money')!.rows.find((r) => r.system_id === moneySys.id)!;
    assert.equal(moneyRow.action.label, 'Open ledger', 'variance offers [Open ledger]');

    // ---- clock crossings are logged once ----------------------------------
    const first = await sweepClocks();
    const second = await sweepClocks();
    assert.ok(first.evaluated > 0, 'sweep finds the ROF hit');
    assert.equal(second.logged, 0, 'a second sweep logs nothing — crossings are guarded');
    const logged = await prisma.activityLog.count({
      where: { entity: 'system', entityId: clockSys.id, action: 'clock' },
    });
    assert.equal(logged, 1, 'exactly one crossing row for the ROF clock');

    // ---- D8 date block -----------------------------------------------------
    const block = todayBlock(new Date('2026-08-30T18:30:00Z'));
    assert.equal(block.weekday, 'Sunday', 'weekday rendered America/New_York');
    assert.equal(block.date, 'Aug 30, 2026', 'date format per D8');
    assert.equal(block.time, '14:30', '18:30Z is 14:30 ET');
    assert.equal(block.tz, 'ET');

    // ---- clear every condition → rows disappear on the next compose -------
    await prisma.alert.update({ where: { id: alert.id }, data: { clearedAt: new Date() } });
    await prisma.system.update({
      where: { id: blockedSys.id },
      data: { blockedCode: null, blockedAt: null, blockedNote: null },
    });
    await prisma.system.update({ where: { id: freshBlocked.id }, data: { blockedCode: null, blockedAt: null } });
    await prisma.system.update({ where: { id: clockSys.id }, data: { cofDate: new Date() } }); // build window closed by COF
    await prisma.turnoverCase.update({ where: { id: turnover.id }, data: { closedAt: new Date() } });
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'SIGNED', signedAt: new Date() } });
    await prisma.ledgerEntry.update({
      where: { id: ledger.id },
      data: { status: 'RECEIVED', receivedAmt: 1200, receivedDate: new Date() },
    });

    const after = await composeToday();
    const mine = (s?: TodaySection) => (s?.rows ?? []).filter((r) => made.systemIds.includes(r.system_id ?? ''));
    assert.equal(mine(section(after, 'health')).length, 0, 'cleared alert leaves the queue');
    assert.equal(mine(section(after, 'blocked')).length, 0, 'unblocked system leaves the queue');
    assert.equal(mine(section(after, 'deadlines')).length, 0, 'closed build window leaves the queue');
    assert.equal(mine(section(after, 'signatures')).length, 0, 'signed envelope leaves the queue');
    assert.equal(mine(section(after, 'money')).length, 0, 'received ledger row leaves the queue');

    // ---- empty sections collapse ------------------------------------------
    const empty = await composeToday();
    assert.ok(
      empty.sections.every((s) => s.rows.length > 0),
      'compose never returns an empty section — empty sections collapse',
    );

    // and the clock engine itself no longer reports the system
    const hits = await evaluateClocks(clockSys.id);
    assert.equal(hits.length, 0, 'clock engine drops the system once its window closed');

    console.log('\n✅ today/clocks e2e PASSED — five sections, correct actions, rows clear on condition clear.');
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  const ids = made.systemIds;
  if (ids.length) {
    await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.document.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.turnoverCase.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (made.propertyId) await prisma.property.deleteMany({ where: { id: made.propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ today/clocks e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
