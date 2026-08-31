/**
 * Fleet — the condition lens (03 §Fleet).
 *
 * Pipeline asks how far along something is; Fleet asks whether it is healthy
 * and earning. This reads `systems` + `health` + alerts + events — never the
 * legacy /api/ops/fleet demo aggregation, which stays where it is (R7).
 *
 * Lens routing (L5): stage IN (S09_LIVE, OPERATING).
 */
import type { Stage } from '@prisma/client';
import prisma from '../config/database';
import { readTelemetry } from '../lib/lifecycle';

const LIVE: Stage[] = ['S09_LIVE', 'OPERATING'];

/**
 * The underwriting derate chain (01 §Derived). Fleet panel only — the measured
 * number calibrates the model and is never persisted.
 */
export const DERATE_CHAIN = [
  { key: 'comms', factor: 0.97 },
  { key: 'temp', factor: 0.97 },
  { key: 'soc', factor: 0.95 },
  { key: 'degradation', factor: 0.92 },
  { key: 'partial', factor: 0.97 },
];
export const DERATE_MODEL = DERATE_CHAIN.reduce((n, d) => n * d.factor, 1);

/** Worst first: FAULT → SERVICE → WATCH → OK → unknown. */
const HEALTH_RANK: Record<string, number> = { FAULT: 0, SERVICE: 1, WATCH: 2, OK: 3 };

/** Pin colour per health, matching the stage/health language used elsewhere. */
const HEALTH_COLOR: Record<string, string> = {
  FAULT: 'var(--r)',
  SERVICE: 'var(--b)',
  WATCH: '#C08A2E',
  OK: 'var(--g)',
};

export async function getFleet(now = new Date()) {
  const season = await prisma.season.findFirst({
    where: { status: 'OPEN' },
    orderBy: [{ programYear: 'desc' }, { name: 'asc' }],
  });

  const systems = await prisma.system.findMany({
    where: { stage: { in: LIVE }, terminalState: null },
    select: {
      id: true,
      addressLine: true,
      unitLabel: true,
      stage: true,
      health: true,
      tier: true,
      flags: true,
      kwRated: true,
      gridEdge: true,
      lockedRates: true,
      enlightenSiteId: true,
      fwVersion: true,
      property: { select: { id: true, name: true, town: true, lat: true, lng: true } },
    },
  });
  const ids = systems.map((s) => s.id);

  const [reads, events, openTickets, openAlerts] = await Promise.all([
    readTelemetry(systems, prisma, now),
    season
      ? prisma.event.findMany({ where: { systemId: { in: ids }, seasonId: season.id } })
      : Promise.resolve([]),
    prisma.ticket.findMany({
      where: { systemId: { in: ids }, state: { notIn: ['CLOSED'] } },
      select: { id: true, systemId: true, state: true, severity: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.alert.findMany({
      where: { systemId: { in: ids }, clearedAt: null },
      select: { systemId: true, severity: true, ruleKey: true },
    }),
  ]);

  const eventsBySystem = new Map<string, typeof events>();
  for (const e of events) {
    const arr = eventsBySystem.get(e.systemId) ?? [];
    arr.push(e);
    eventsBySystem.set(e.systemId, arr);
  }
  const ticketBySystem = new Map<string, (typeof openTickets)[number]>();
  for (const t of openTickets) if (!ticketBySystem.has(t.systemId)) ticketBySystem.set(t.systemId, t);

  // Fleet-level expected kW per event: the mean nomination across the season.
  const nominated = events.map((e) => (e.kwNominated == null ? null : Number(e.kwNominated))).filter((v): v is number => v != null);
  const fleetExpectedKw = nominated.length ? nominated.reduce((a, b) => a + b, 0) / nominated.length : null;

  const rows = systems.map((s) => {
    const read = reads.get(s.id);
    const mine = eventsBySystem.get(s.id) ?? [];
    const delivered = mine.map((e) => (e.kwDelivered == null ? null : Number(e.kwDelivered))).filter((v): v is number => v != null);
    const seasonAvgKw = delivered.length ? delivered.reduce((a, b) => a + b, 0) / delivered.length : null;
    const last = mine.length
      ? mine.reduce((a, b) => (a.date > b.date ? a : b))
      : null;
    const ticket = ticketBySystem.get(s.id) ?? null;

    // 02 §Automations — first event with kW > 0 earns the dispatch-verified
    // badge. Derived, never stored (01 §Derived).
    const dispatchVerified = delivered.some((kw) => kw > 0);

    return {
      id: s.id,
      address: s.addressLine,
      unit_label: s.unitLabel,
      property: s.property ? { id: s.property.id, name: s.property.name, town: s.property.town } : null,
      tier: s.tier,
      grid_edge: s.gridEdge,
      flags: s.flags,
      health: s.health,
      comms_30d: read?.comms30 ?? null,
      comms_measurable: read?.commsMeasurable ?? false,
      hours_since_seen: read?.hoursSinceSeen == null ? null : Math.round(read.hoursSinceSeen * 10) / 10,
      soc: read?.soc ?? null,
      fw: read?.fw ?? null,
      last_event:
        last && last.kwDelivered != null
          ? { kw: Number(last.kwDelivered), ratio: last.ratio == null ? null : Number(last.ratio), date: last.date }
          : null,
      season_avg_kw: seasonAvgKw,
      season_expected_kw: fleetExpectedKw,
      dispatch_verified: dispatchVerified,
      open_ticket: ticket ? { id: ticket.id, state: ticket.state, severity: ticket.severity } : null,
      kw_rated: s.kwRated == null ? null : Number(s.kwRated),
    };
  });

  // Worst-first: health rank, then an open ticket, then weakest comms.
  rows.sort((a, b) => {
    const h = (HEALTH_RANK[a.health ?? ''] ?? 4) - (HEALTH_RANK[b.health ?? ''] ?? 4);
    if (h !== 0) return h;
    const t = (a.open_ticket ? 0 : 1) - (b.open_ticket ? 0 : 1);
    if (t !== 0) return t;
    return (a.comms_30d ?? 1) - (b.comms_30d ?? 1);
  });

  // ---- season strip -------------------------------------------------------
  const reporting = rows.filter((r) => r.hours_since_seen != null && r.hours_since_seen < 4).length;
  const fleetKw = rows.reduce((n, r) => n + (r.kw_rated ?? 0), 0);
  const openFaults = openAlerts.filter((a) => a.severity === 'FAULT').length;

  // Season expected $ per 01 §Derived: 0.5 × annual_rate × AVG(kw_delivered).
  const seasonExpected = rows.reduce((sum, r) => {
    const rates = systems.find((s) => s.id === r.id)?.lockedRates as { annual_rate?: number | null } | null;
    const annual = rates?.annual_rate ?? null;
    if (!annual || r.season_avg_kw == null) return sum;
    return sum + 0.5 * annual * r.season_avg_kw;
  }, 0);

  const strip = {
    active_systems: rows.length,
    online_pct: rows.length ? reporting / rows.length : null,
    reporting,
    fleet_kw: Math.round(fleetKw),
    events_this_season: events.length,
    season_expected: Math.round(seasonExpected),
    open_faults: openFaults,
  };

  // ---- map pins: grouped by town, worst health wins the colour ------------
  // Real coordinates travel with the pin (mean of the town's properties) so the
  // client projects them, rather than carrying a hardcoded town→xy table.
  const byTown = new Map<string, { town: string; count: number; worst: string | null; lats: number[]; lngs: number[] }>();
  for (const r of rows) {
    const town = r.property?.town ?? 'Unknown';
    const cur = byTown.get(town) ?? { town, count: 0, worst: null, lats: [], lngs: [] };
    cur.count += 1;
    if ((HEALTH_RANK[r.health ?? ''] ?? 4) < (HEALTH_RANK[cur.worst ?? ''] ?? 4)) cur.worst = r.health;
    const prop = systems.find((s) => s.id === r.id)?.property;
    if (prop?.lat != null && prop?.lng != null) {
      cur.lats.push(prop.lat);
      cur.lngs.push(prop.lng);
    }
    byTown.set(town, cur);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pins = [...byTown.values()]
    .map(({ lats, lngs, ...p }) => ({
      ...p,
      lat: mean(lats),
      lng: mean(lngs),
      color: HEALTH_COLOR[p.worst ?? ''] ?? 'var(--bd2)',
    }))
    .sort((a, b) => b.count - a.count);

  const healthCounts = rows.reduce<Record<string, number>>((acc, r) => {
    const k = r.health ?? 'UNKNOWN';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  // ---- derate vs actual ---------------------------------------------------
  const ratios = events.map((e) => (e.ratio == null ? null : Number(e.ratio))).filter((v): v is number => v != null);
  const measured = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  return {
    season: season
      ? { id: season.id, name: season.name, program_year: season.programYear, window: season.window, status: season.status }
      : null,
    strip,
    pins,
    health_counts: healthCounts,
    systems: rows,
    derate: {
      chain: DERATE_CHAIN,
      model: Number(DERATE_MODEL.toFixed(4)),
      measured: measured == null ? null : Number(measured.toFixed(4)),
      delta: measured == null ? null : Number((measured - DERATE_MODEL).toFixed(4)),
      events_sampled: ratios.length,
    },
  };
}
