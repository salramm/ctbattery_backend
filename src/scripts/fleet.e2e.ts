/**
 * Fleet lens / poller / health-rules integration test (P7 acceptance).
 *
 * The headline scenario, end to end through the real poller:
 *   a gateway 25 hours dark → FAULT alert (offline_24h) → auto-ticket with
 *   remote steps queued → systems.health = FAULT → a row in the Today queue.
 *   Then 48 hours of restored telemetry → the alert clears, the ticket is
 *   claimed RESOLVED by the machine and auto-VERIFIES per the rule's own check.
 *
 * Also covers: the 4h WATCH ladder, S07 telemetry_confirmed (the machine, not
 * the crew, closes S07), the DERMS block 7 days after install, event-driven
 * rules, and the Fleet payload's strip/sort/derate.
 *
 * Self-cleaning.  npx ts-node src/scripts/fleet.e2e.ts
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import { pollFleet } from '../services/poller.service';
import { getFleet, DERATE_MODEL } from '../services/fleet.service';
import { composeToday } from '../services/today.service';
import { evaluateEventRules, computeHealth, RULES } from '../lib/lifecycle';

const MARK = `P7E2E-${Date.now()}`;
const HOUR = 3_600_000;
const made = { systemIds: [] as string[], siteIds: [] as string[], propertyId: '' };

const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

/** A system wired to its own monitoring site, with an hourly telemetry series. */
async function makeSystem(
  label: string,
  opts: { stage?: string; hoursOfHistory?: number; goDarkHoursAgo?: number; data?: Record<string, unknown> } = {},
) {
  const siteId = `${MARK}-${label}`;
  const system = await prisma.system.create({
    data: {
      propertyId: made.propertyId,
      unitLabel: label,
      addressLine: `${MARK} ${label}`,
      stage: (opts.stage ?? 'OPERATING') as never,
      kwRated: 11.5,
      kwhRated: 15,
      tier: 'LI',
      enlightenSiteId: siteId,
      ...(opts.data ?? {}),
    },
  });
  made.systemIds.push(system.id);

  const site = await prisma.monitoringSite.create({
    data: {
      // No spine Project — that FK is nullable precisely so a lifecycle system
      // can own a monitoring site (migration 20260831090000).
      projectId: null,
      provider: 'Enphase',
      providerSiteId: siteId,
      lastSeenAt: hoursAgo(opts.goDarkHoursAgo ?? 0),
    },
  });
  made.siteIds.push(site.id);

  // Hourly samples from `hoursOfHistory` ago until the system went dark.
  const history = opts.hoursOfHistory ?? 0;
  const dark = opts.goDarkHoursAgo ?? 0;
  const rows = [];
  for (let h = history; h > dark; h--) {
    rows.push({ monitoringSiteId: site.id, ts: hoursAgo(h), soc: 70, powerKw: 0, mode: 'SELF_CONSUMPTION', gridConnected: true });
  }
  if (rows.length) await prisma.telemetrySnapshot.createMany({ data: rows });
  return { system, site };
}

async function addTelemetry(siteId: string, fromHoursAgo: number, toHoursAgo: number) {
  const rows = [];
  for (let h = fromHoursAgo; h >= toHoursAgo; h--) {
    rows.push({ monitoringSiteId: siteId, ts: hoursAgo(h), soc: 82, powerKw: 1.2, mode: 'SELF_CONSUMPTION', gridConnected: true });
  }
  await prisma.telemetrySnapshot.createMany({ data: rows });
}

async function run() {
  const property = await prisma.property.create({
    data: { address: `${MARK} 9 Fleet St`, town: 'Greenwich', postalCode: '06830', county: 'Fairfield' },
  });
  made.propertyId = property.id;

  try {
    // ═══ the headline scenario: a gateway 25 hours dark ═══════════════════
    const { system: dark, site: darkSite } = await makeSystem('3C', {
      hoursOfHistory: 80,
      goDarkHoursAgo: 25,
    });

    // Scoped to this test's own fixtures — a poll pass must never open alerts
    // on systems the test did not create.
    let poll = await pollFleet(made.systemIds);
    const darkOutcome = poll.outcomes.find((o) => o.systemId === dark.id)!;
    assert.ok(darkOutcome, 'the offline system was polled');
    assert.ok(darkOutcome.hoursSinceSeen! >= 25, `seen ${darkOutcome.hoursSinceSeen}h ago`);

    // → FAULT alert
    const alert = await prisma.alert.findFirst({ where: { systemId: dark.id, ruleKey: 'offline_24h', clearedAt: null } });
    assert.ok(alert, 'offline_24h alert opened');
    assert.equal(alert!.severity, 'FAULT', 'offline_24h is a FAULT');

    // → auto-ticket, with the remote steps queued before any field visit
    assert.ok(alert!.ticketId, 'alert auto-opened a ticket');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: alert!.ticketId! } });
    assert.equal(ticket.category, 'COMMS', 'ticket lands in the COMMS category');
    assert.equal(ticket.source, 'auto');
    assert.equal(ticket.state, 'NEW');
    assert.ok((ticket.remoteLog as unknown[]).length > 0, 'remote steps queued first');

    // → health = FAULT
    const afterOpen = await prisma.system.findUniqueOrThrow({ where: { id: dark.id } });
    assert.equal(afterOpen.health, 'FAULT', 'health cache recomputed to FAULT');
    assert.equal(await computeHealth(dark.id), 'FAULT', 'computeHealth agrees');

    // → lands on Today
    const today = await composeToday();
    const healthSection = today.sections.find((s) => s.key === 'health');
    const todayRow = healthSection?.rows.find((r) => r.system_id === dark.id);
    assert.ok(todayRow, 'the FAULT lands in the Today health section');
    assert.equal(todayRow!.severity, 'FAULT');
    assert.equal(todayRow!.action.label, 'View', 'an alert that already has a ticket offers [View]');

    // idempotent: a second poll neither stacks an alert nor a ticket
    await pollFleet(made.systemIds);
    assert.equal(
      await prisma.alert.count({ where: { systemId: dark.id, ruleKey: 'offline_24h', clearedAt: null } }),
      1,
      'a second poll does not stack alerts',
    );
    assert.equal(await prisma.ticket.count({ where: { systemId: dark.id } }), 1, 'nor tickets');

    // ═══ restored telemetry for 48h auto-verifies per the rule ════════════
    // Not yet: only 10h of fresh telemetry, so the 48h check must fail.
    await addTelemetry(darkSite.id, 10, 0);
    await pollFleet(made.systemIds);
    const partial = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    assert.equal(partial.state, 'RESOLVED', 'reporting resumed → machine claims the fix');
    assert.equal(partial.resolutionCode, 'REMOTE_FIX');
    assert.equal(partial.verifiedAt, null, 'but 10h is not 48h — it stays unverified');

    // Now backfill a full clean 48h and re-poll.
    await addTelemetry(darkSite.id, 48, 11);
    poll = await pollFleet(made.systemIds);
    const closed = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    assert.equal(closed.state, 'CLOSED', '48h clean telemetry verifies and closes the ticket');
    assert.ok(closed.verifiedAt, 'verified stamp written by the machine');
    assert.equal(
      await prisma.alert.count({ where: { systemId: dark.id, ruleKey: 'offline_24h', clearedAt: null } }),
      0,
      'alert cleared',
    );
    const healthy = await prisma.system.findUniqueOrThrow({ where: { id: dark.id } });
    assert.equal(healthy.health, 'OK', 'health falls back to OK once nothing is open');

    const todayAfter = await composeToday();
    assert.ok(
      !(todayAfter.sections.find((s) => s.key === 'health')?.rows ?? []).some((r) => r.system_id === dark.id),
      'the row leaves Today once the alert clears',
    );

    // ═══ the 4h WATCH rung ════════════════════════════════════════════════
    const { system: dim } = await makeSystem('7B', { hoursOfHistory: 60, goDarkHoursAgo: 6 });
    await pollFleet(made.systemIds);
    const watch = await prisma.alert.findFirst({ where: { systemId: dim.id, ruleKey: 'offline_4h', clearedAt: null } });
    assert.ok(watch, 'offline_4h opened at 6h dark');
    assert.equal(watch!.severity, 'WATCH');
    assert.equal(
      await prisma.ticket.count({ where: { systemId: dim.id } }),
      0,
      'offline_4h files no ticket — resident SMS only, per the seed',
    );
    assert.equal((await prisma.system.findUniqueOrThrow({ where: { id: dim.id } })).health, 'WATCH');

    // ═══ S07: the machine confirms telemetry, not the crew ════════════════
    const { system: installing } = await makeSystem('9A', { stage: 'S07_INSTALLED', hoursOfHistory: 3, goDarkHoursAgo: 0 });
    // Field checklist complete except the auto-only telemetry item.
    const s07Items = await prisma.checklistItem.findMany({ where: { systemId: installing.id, stage: 'S07_INSTALLED' } });
    assert.ok(s07Items.length === 0, 'no S07 checklist yet — this system was created directly at S07');
    await prisma.checklistItem.create({
      data: {
        systemId: installing.id,
        stage: 'S07_INSTALLED',
        key: 'telemetry_confirmed',
        label: 'Telemetry confirmed',
        required: true,
      },
    });
    await pollFleet(made.systemIds);
    const telemetryItem = await prisma.checklistItem.findFirstOrThrow({
      where: { systemId: installing.id, key: 'telemetry_confirmed' },
    });
    assert.equal(telemetryItem.state, 'DONE', 'poller marked telemetry_confirmed');

    // ═══ DERMS block 7 days after install ═════════════════════════════════
    const { system: commissioning } = await makeSystem('2A', {
      stage: 'S08_COMMISSIONED',
      hoursOfHistory: 3,
      goDarkHoursAgo: 0,
      data: { installDate: new Date(Date.now() - 9 * 24 * HOUR) },
    });
    await prisma.checklistItem.create({
      data: {
        systemId: commissioning.id,
        stage: 'S08_COMMISSIONED',
        key: 'derms_visible',
        label: 'DERMS visible',
        required: true,
      },
    });
    await pollFleet(made.systemIds);
    const blocked = await prisma.system.findUniqueOrThrow({ where: { id: commissioning.id } });
    assert.equal(blocked.blockedCode, 'B-DERMS', 'DERMS still dark 9 days after install → B-DERMS');

    // ═══ event-driven rules ═══════════════════════════════════════════════
    const season = await prisma.season.findFirstOrThrow({ where: { status: 'OPEN' } });
    const zeroEvent = await prisma.event.create({
      data: { systemId: dim.id, seasonId: season.id, date: new Date(), window: 'PM1', kwNominated: 11.3, kwDelivered: 0, ratio: 0, source: 'MANUAL' },
    });
    const fired = await evaluateEventRules(zeroEvent.id);
    assert.ok(fired.includes('event_zero'), '0 kW at an event fires event_zero');
    const zeroAlert = await prisma.alert.findFirstOrThrow({ where: { systemId: dim.id, ruleKey: 'event_zero', clearedAt: null } });
    assert.equal(zeroAlert.severity, 'FAULT');
    assert.ok(zeroAlert.ticketId, 'event_zero opens a ticket carrying the event context');

    // a good next event answers it
    const goodEvent = await prisma.event.create({
      data: { systemId: dim.id, seasonId: season.id, date: new Date(Date.now() + 864e5), window: 'PM1', kwNominated: 11.3, kwDelivered: 10.9, ratio: 0.96, source: 'MANUAL' },
    });
    const fired2 = await evaluateEventRules(goodEvent.id);
    assert.ok(fired2.includes('event_zero:cleared'), 'next event with kW > 0 clears event_zero');
    const zeroTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: zeroAlert.ticketId! } });
    assert.equal(zeroTicket.state, 'CLOSED', 'and the rule machine-check closes its ticket');

    // ═══ Fleet payload ════════════════════════════════════════════════════
    const fleet = await getFleet();
    assert.ok(fleet.strip.active_systems >= 2, 'strip counts Live/Operating systems');
    assert.equal(typeof fleet.strip.online_pct, 'number', 'online % present');
    assert.ok(fleet.strip.fleet_kw > 0, 'fleet kW summed');
    assert.equal(fleet.derate.model, Number(DERATE_MODEL.toFixed(4)), 'derate model chain is 0.81');
    assert.ok(fleet.derate.measured != null, 'measured ratio computed from season events');
    assert.ok(fleet.pins.length > 0, 'map pins grouped by town');

    const mine = fleet.systems.filter((s) => made.systemIds.includes(s.id));
    assert.ok(mine.length >= 2, 'fixtures appear in the fleet table');
    const dimRow = mine.find((s) => s.id === dim.id)!;
    assert.ok(dimRow.dispatch_verified, 'a system with an event over 0 kW is dispatch-verified');
    assert.ok(dimRow.season_avg_kw != null, 'season average computed');

    // worst-first ordering holds across the whole table
    const rank: Record<string, number> = { FAULT: 0, SERVICE: 1, WATCH: 2, OK: 3 };
    const ranks = fleet.systems.map((s) => rank[s.health ?? ''] ?? 4);
    assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'table is sorted worst-first');

    // every seeded rule has mechanics defined
    const seeded = await prisma.alertRule.findMany({ select: { key: true } });
    for (const r of seeded) assert.ok(RULES[r.key], `rule ${r.key} has a spec (ticketing + machine check)`);

    console.log('\n✅ fleet/poller/health e2e PASSED — 25h dark → FAULT + ticket + health + Today; 48h clean → auto-verified.');
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  const ids = made.systemIds;
  if (ids.length) {
    await prisma.event.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ticket.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (made.siteIds.length) {
    await prisma.telemetrySnapshot.deleteMany({ where: { monitoringSiteId: { in: made.siteIds } } });
    await prisma.monitoringSite.deleteMany({ where: { id: { in: made.siteIds } } });
  }
  if (made.propertyId) await prisma.property.deleteMany({ where: { id: made.propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ fleet e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
