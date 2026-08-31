/**
 * The monitoring poller (02 §On-enter S07/S08, §Automations).
 *
 * One pass reads the telemetry store for every system that has an X3 site id
 * and, per stage, does the one thing that stage is waiting for:
 *
 *   S07 — telemetry seen ⇒ mark `telemetry_confirmed`. The machine closes S07,
 *         not the crew (01 §Seed). This is the AUTO S07→S08 trigger.
 *   S08 — DERMS still not visible 7 days after install ⇒ block `B-DERMS`.
 *   S09 / OPERATING — evaluate the telemetry alert rules (offline 4h/24h,
 *         30-day comms), clear them when they resolve, refresh the health cache.
 *
 * The store is shared with the legacy monitoring surface and holds several
 * providers (Enphase, FranklinWH, Tesla), so this reads snapshots generically
 * rather than assuming one vendor's payload.
 */
import type { Stage } from '@prisma/client';
import prisma from '../config/database';
import {
  clearAlert,
  openAlert,
  onTelemetryConfirmed,
  onDermsVisible,
  readTelemetry,
  recomputeHealth,
  runVerifications,
  MIN_SAMPLES_FOR_COMMS,
  type TelemetryRead,
} from '../lib/lifecycle';

/** Stages the poller watches. */
const WATCHED: Stage[] = ['S07_INSTALLED', 'S08_COMMISSIONED', 'S09_LIVE', 'OPERATING'];
const LIVE: Stage[] = ['S09_LIVE', 'OPERATING'];

/** Thresholds from 01 §Alert rules. */
const OFFLINE_WATCH_HOURS = 4;
const OFFLINE_FAULT_HOURS = 24;
const COMMS_OPEN_BELOW = 0.95;
const COMMS_CLEAR_AT = 0.97;
/** A system counts as reporting for S07 purposes if seen within this window. */
const REPORTING_HOURS = 24;
/** 02 §Automations — DERMS not visible 7 days after install. */
const DERMS_BLOCK_AFTER_DAYS = 7;

export interface PollOutcome {
  systemId: string;
  address: string | null;
  stage: Stage;
  hoursSinceSeen: number | null;
  comms30: number | null;
  actions: string[];
}

export interface PollSummary {
  at: Date;
  polled: number;
  skippedNoSite: number;
  verified: number;
  outcomes: PollOutcome[];
}

/**
 * Telemetry rules for a Live/Operating system. Offline is a ladder: past 24h it
 * is a FAULT and supersedes the 4h WATCH, so the two never both stand.
 */
async function applyTelemetryRules(systemId: string, read: TelemetryRead, now: Date): Promise<string[]> {
  const actions: string[] = [];
  const hours = read.hoursSinceSeen;

  if (hours == null) {
    // Never heard from at all — treat as offline only if we know it should be
    // reporting; without a site link there is nothing to conclude.
    return actions;
  }

  if (hours >= OFFLINE_FAULT_HOURS) {
    const res = await openAlert(systemId, 'offline_24h', { hours_offline: Math.round(hours), last_seen: read.lastSeenAt }, prisma);
    if (res.created) actions.push(`offline_24h opened${res.ticketId ? ` + ticket ${res.ticketId}` : ''}`);
    // The 4h WATCH is subsumed by the FAULT.
    if (await clearAlert(systemId, 'offline_4h', prisma, now)) actions.push('offline_4h superseded');
  } else if (hours >= OFFLINE_WATCH_HOURS) {
    const res = await openAlert(systemId, 'offline_4h', { hours_offline: Math.round(hours) }, prisma);
    if (res.created) actions.push('offline_4h opened');
    if (await clearAlert(systemId, 'offline_24h', prisma, now)) actions.push('offline_24h cleared');
  } else {
    // Reporting again.
    if (await clearAlert(systemId, 'offline_4h', prisma, now)) actions.push('offline_4h cleared');
    if (await clearAlert(systemId, 'offline_24h', prisma, now)) actions.push('offline_24h cleared');
  }

  // 30-day comms. Only judged when there are enough samples to have a baseline;
  // a sparse store is missing data, not a degraded link.
  if (read.commsMeasurable && read.comms30 != null) {
    if (read.comms30 < COMMS_OPEN_BELOW) {
      const res = await openAlert(systemId, 'comms_30d', { comms_30d: Number(read.comms30.toFixed(4)) }, prisma);
      if (res.created) actions.push('comms_30d opened');
    } else if (read.comms30 >= COMMS_CLEAR_AT) {
      if (await clearAlert(systemId, 'comms_30d', prisma, now)) actions.push('comms_30d cleared');
    }
  }

  return actions;
}

/** S07: the machine confirms telemetry and closes the stage. */
async function applyS07(systemId: string, read: TelemetryRead): Promise<string[]> {
  if (read.hoursSinceSeen == null || read.hoursSinceSeen > REPORTING_HOURS) return [];
  const item = await prisma.checklistItem.findFirst({
    where: { systemId, key: 'telemetry_confirmed', state: { not: 'DONE' } },
  });
  if (!item) return [];
  await onTelemetryConfirmed(systemId);
  return ['telemetry_confirmed'];
}

/** S08: DERMS visibility, and the block when it is overdue. */
async function applyS08(systemId: string, installDate: Date | null, dermsId: string | null, now: Date): Promise<string[]> {
  const actions: string[] = [];
  const item = await prisma.checklistItem.findFirst({
    where: { systemId, key: 'derms_visible', stage: 'S08_COMMISSIONED' },
  });
  if (!item || item.state === 'DONE') return actions;

  // A DERMS id present means the platform can see it — that IS the confirmation.
  if (dermsId) {
    await onDermsVisible(systemId, { dermsId });
    actions.push('derms_visible');
    return actions;
  }

  if (installDate) {
    const days = (now.getTime() - installDate.getTime()) / 86_400_000;
    if (days >= DERMS_BLOCK_AFTER_DAYS) {
      const system = await prisma.system.findUnique({ where: { id: systemId }, select: { blockedCode: true } });
      if (!system?.blockedCode) {
        await prisma.system.update({
          where: { id: systemId },
          data: {
            blockedCode: 'B-DERMS',
            blockedAt: now,
            blockedNote: `Not visible in EnergyHub ${Math.floor(days)}d after install`,
          },
        });
        await prisma.activityLog.create({
          data: { entity: 'system', entityId: systemId, action: 'block', actor: 'system', meta: { code: 'B-DERMS' } },
        });
        actions.push('B-DERMS blocked');
      }
    }
  }
  return actions;
}

/**
 * Run one poll pass. `scope` narrows to one system or an explicit set — used by
 * an on-demand refresh from the System page, and by tests, which must never
 * reach beyond their own fixtures into the rest of the fleet.
 */
export async function pollFleet(scope?: string | string[], now = new Date()): Promise<PollSummary> {
  const ids = scope == null ? null : Array.isArray(scope) ? scope : [scope];
  const systems = await prisma.system.findMany({
    where: { stage: { in: WATCHED }, terminalState: null, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      addressLine: true,
      stage: true,
      enlightenSiteId: true,
      fwVersion: true,
      installDate: true,
      dermsId: true,
    },
  });

  const reads = await readTelemetry(systems, prisma, now);
  const outcomes: PollOutcome[] = [];
  let skippedNoSite = 0;

  for (const system of systems) {
    const read = reads.get(system.id);
    if (!read || !read.siteId) {
      skippedNoSite += 1;
      continue;
    }

    const actions: string[] = [];
    if (system.stage === 'S07_INSTALLED') {
      actions.push(...(await applyS07(system.id, read)));
    } else if (system.stage === 'S08_COMMISSIONED') {
      actions.push(...(await applyS08(system.id, system.installDate, system.dermsId, now)));
    } else if (LIVE.includes(system.stage)) {
      actions.push(...(await applyTelemetryRules(system.id, read, now)));
      await recomputeHealth(system.id, prisma);
    }

    outcomes.push({
      systemId: system.id,
      address: system.addressLine,
      stage: system.stage,
      hoursSinceSeen: read.hoursSinceSeen == null ? null : Math.round(read.hoursSinceSeen * 10) / 10,
      comms30: read.comms30,
      actions,
    });
  }

  // Claimed resolutions whose machine check now passes (e.g. 48h clean
  // telemetry). Scoped with the pass, so a single-system poll stays single.
  const verified = await runVerifications(prisma, now, ids ?? undefined);

  return { at: now, polled: outcomes.length, skippedNoSite, verified, outcomes };
}

export const POLLER_THRESHOLDS = {
  OFFLINE_WATCH_HOURS,
  OFFLINE_FAULT_HOURS,
  COMMS_OPEN_BELOW,
  COMMS_CLEAR_AT,
  REPORTING_HOURS,
  DERMS_BLOCK_AFTER_DAYS,
  MIN_SAMPLES_FOR_COMMS,
};
