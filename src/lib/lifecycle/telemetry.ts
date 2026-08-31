/**
 * Telemetry reads for the poller and the alert rules.
 *
 * `TelemetrySnapshot` is the telemetry store and stays that way — it is never
 * folded into `events`. Events are the dispatch record (one row per system per
 * event window, 01); telemetry is the continuous feed. They answer different
 * questions and are kept apart on purpose.
 *
 * The bridge from a lifecycle system to the store is X3:
 *   systems.enlighten_site_id → monitoring_sites.provider_site_id → snapshots
 * `monitoring_sites.last_seen_at` bootstraps a system that has no snapshot rows
 * yet, so a freshly commissioned site is not mistaken for an outage.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';

type Client = Prisma.TransactionClient | typeof prisma;

/** Snapshots are expected roughly hourly; comms% is measured against that. */
export const EXPECTED_SAMPLE_INTERVAL_HOURS = 1;

/**
 * Below this many observed samples we have no baseline, so comms% is reported
 * but never used to raise an alert — "we aren't hearing enough to judge" is not
 * the same finding as "the link is degraded".
 */
export const MIN_SAMPLES_FOR_COMMS = 24;

export interface TelemetryRead {
  systemId: string;
  siteId: string | null;
  monitoringSiteId: string | null;
  provider: string | null;
  /** Newest snapshot timestamp, falling back to monitoring_sites.last_seen_at. */
  lastSeenAt: Date | null;
  hoursSinceSeen: number | null;
  soc: number | null;
  powerKw: number | null;
  gridConnected: boolean | null;
  /**
   * Distinct sample-hours observed ÷ hours expected. 0–1. The denominator runs
   * from the first observation in the window, not a flat 30 days, so a system
   * live for three days is not scored as though it missed twenty-seven.
   */
  comms30: number | null;
  samples30: number;
  /** True when we have enough samples for comms30 to mean anything. */
  commsMeasurable: boolean;
  /** Firmware is not carried by the telemetry store; this is the recorded value. */
  fw: string | null;
}

const HOUR = 3_600_000;

/**
 * Read the current telemetry picture for a set of systems in three queries,
 * regardless of how many systems are passed.
 */
export async function readTelemetry(
  systems: Array<{ id: string; enlightenSiteId: string | null; fwVersion: string | null }>,
  client: Client = prisma,
  now = new Date(),
  windowDays = 30,
): Promise<Map<string, TelemetryRead>> {
  const out = new Map<string, TelemetryRead>();
  const siteIds = systems.map((s) => s.enlightenSiteId).filter((v): v is string => Boolean(v));

  const sites = siteIds.length
    ? await client.monitoringSite.findMany({
        where: { providerSiteId: { in: siteIds } },
        select: { id: true, providerSiteId: true, provider: true, lastSeenAt: true },
      })
    : [];
  const siteByProviderId = new Map(sites.map((s) => [s.providerSiteId, s]));

  const since = new Date(now.getTime() - windowDays * 24 * HOUR);
  const snapshots = sites.length
    ? await client.telemetrySnapshot.findMany({
        where: { monitoringSiteId: { in: sites.map((s) => s.id) }, ts: { gte: since } },
        select: { monitoringSiteId: true, ts: true, soc: true, powerKw: true, gridConnected: true },
        orderBy: { ts: 'asc' },
      })
    : [];

  const bySite = new Map<string, typeof snapshots>();
  for (const snap of snapshots) {
    const arr = bySite.get(snap.monitoringSiteId) ?? [];
    arr.push(snap);
    bySite.set(snap.monitoringSiteId, arr);
  }

  for (const system of systems) {
    const site = system.enlightenSiteId ? siteByProviderId.get(system.enlightenSiteId) : undefined;
    const rows = site ? bySite.get(site.id) ?? [] : [];
    const newest = rows.length ? rows[rows.length - 1] : null;

    // Distinct sample-hours: two snapshots in the same hour still count once, so
    // a chatty inverter can't inflate its own comms score.
    const hours = new Set(rows.map((r) => Math.floor(r.ts.getTime() / HOUR)));
    const lastSeenAt = newest?.ts ?? site?.lastSeenAt ?? null;

    // Expect one sample per interval from the first observation onwards, capped
    // at the window. A young system is judged on the time it has actually been
    // reporting.
    const firstSeen = rows.length ? rows[0].ts : null;
    const observedSpanHours = firstSeen ? (now.getTime() - firstSeen.getTime()) / HOUR : 0;
    const expectedHours = Math.max(
      1,
      Math.min(windowDays * 24, observedSpanHours) / EXPECTED_SAMPLE_INTERVAL_HOURS,
    );

    out.set(system.id, {
      systemId: system.id,
      siteId: system.enlightenSiteId,
      monitoringSiteId: site?.id ?? null,
      provider: site?.provider ?? null,
      lastSeenAt,
      hoursSinceSeen: lastSeenAt ? (now.getTime() - lastSeenAt.getTime()) / HOUR : null,
      soc: newest?.soc ?? null,
      powerKw: newest?.powerKw ?? null,
      gridConnected: newest?.gridConnected ?? null,
      comms30: rows.length ? Math.min(1, hours.size / expectedHours) : null,
      samples30: rows.length,
      commsMeasurable: hours.size >= MIN_SAMPLES_FOR_COMMS,
      fw: system.fwVersion,
    });
  }

  return out;
}

/** Read one system's telemetry. */
export async function readOne(
  system: { id: string; enlightenSiteId: string | null; fwVersion: string | null },
  client: Client = prisma,
  now = new Date(),
): Promise<TelemetryRead | null> {
  return (await readTelemetry([system], client, now)).get(system.id) ?? null;
}

/**
 * True when every hour in the trailing `hours` window carries a sample — the
 * "48h clean telemetry" check that closes an offline ticket.
 */
export async function hasCleanTelemetry(
  system: { id: string; enlightenSiteId: string | null },
  hours: number,
  client: Client = prisma,
  now = new Date(),
  /** Allow this fraction of hours to be missing before calling it dirty. */
  tolerance = 0.1,
): Promise<boolean> {
  if (!system.enlightenSiteId) return false;
  const site = await client.monitoringSite.findFirst({
    where: { providerSiteId: system.enlightenSiteId },
    select: { id: true },
  });
  if (!site) return false;

  const since = new Date(now.getTime() - hours * HOUR);
  const rows = await client.telemetrySnapshot.findMany({
    where: { monitoringSiteId: site.id, ts: { gte: since } },
    select: { ts: true },
  });
  const observed = new Set(rows.map((r) => Math.floor(r.ts.getTime() / HOUR))).size;
  const expected = hours / EXPECTED_SAMPLE_INTERVAL_HOURS;
  return observed >= expected * (1 - tolerance);
}
