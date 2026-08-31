/**
 * The clock engine (01 §Seed — clocks; 02 §Automations: "Any date crosses a
 * clock threshold → Today countdown row").
 *
 * Every threshold — window length and warn offset — is read from the `clocks`
 * seed rows. Nothing here hardcodes "24 months" or "day 2": change the seed and
 * the engine changes. What the registry below supplies is only *where each
 * clock's start date lives*, because `clocks.starts_on` is prose
 * ("rof_date", "turnover_cases.opened_at") rather than a column reference the
 * database could follow on its own.
 *
 * Two entry points, same evaluation:
 *   • `sweepClocks()`   — the cron pass over the whole fleet
 *   • `evaluateSystemClocks(id)` — the on-write pass for one system
 * Both funnel into `recordCrossings`, which logs each threshold crossing to
 * `activity_log` exactly once, so a nightly cron and a same-day date write
 * never double-notify.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { addBusinessDays, addDays, addMonths, daysBetween } from './dates';
import { notify } from './notifications';

type Client = Prisma.TransactionClient | typeof prisma;

export type ClockLevel = 'WARN' | 'DUE';

export interface ClockHit {
  clock: string;
  level: ClockLevel;
  systemId: string | null;
  addressLine: string | null;
  startedAt: Date | null;
  warnAt: Date | null;
  dueAt: Date | null;
  /** Days until due; negative once overdue. */
  daysToDue: number | null;
  consequence: string | null;
  context: Record<string, unknown>;
}

/** One thing a clock is ticking on — a system, an enrollment, a turnover case. */
interface Subject {
  systemId: string | null;
  addressLine: string | null;
  start: Date;
  /** Set when the source row carries the deadline directly (see cgb_deficiency). */
  dueOverride?: Date;
  context?: Record<string, unknown>;
}

/**
 * The 48E(h) low-income allocation window is annual and fleet-wide, not a
 * per-system date. The `clocks` seed carries it only as prose in `consequence`,
 * so the structured dates live here until the seed grows columns for them.
 */
const LI_WINDOW: Record<number, { open: string; close: string }> = {
  2026: { open: '2026-02-02', close: '2026-08-07' },
};

interface Source {
  /** Whether this clock produces a Today countdown row (03 §Today, section 3). */
  todayRow: boolean;
  load(client: Client, systemId?: string): Promise<Subject[]>;
}

const SOURCES: Record<string, Source> = {
  // 24-month build window opened by the ROF; closed once COF lands.
  rof_build: {
    todayRow: true,
    load: async (client, systemId) => {
      const rows = await client.system.findMany({
        where: { rofDate: { not: null }, cofDate: null, terminalState: null, ...(systemId ? { id: systemId } : {}) },
        select: { id: true, addressLine: true, rofDate: true, cgbAppNo: true },
      });
      return rows.map((r) => ({
        systemId: r.id,
        addressLine: r.addressLine,
        start: r.rofDate!,
        context: { app_no: r.cgbAppNo },
      }));
    },
  },

  // 120-month performance term opened by the COF.
  performance_term: {
    todayRow: true,
    load: async (client, systemId) => {
      const rows = await client.system.findMany({
        where: { cofDate: { not: null }, terminalState: null, ...(systemId ? { id: systemId } : {}) },
        select: { id: true, addressLine: true, cofDate: true },
      });
      return rows.map((r) => ({ systemId: r.id, addressLine: r.addressLine, start: r.cofDate! }));
    },
  },

  // CGB deficiency. The schema stores the deadline (`deficiency_due`), not the
  // moment it was raised, so the due date is taken directly and the start is
  // walked back by the seed's business-day length.
  cgb_deficiency: {
    todayRow: true,
    load: async (client, systemId) => {
      const rows = await client.enrollment.findMany({
        where: {
          deficiencyDue: { not: null },
          system: { terminalState: null },
          ...(systemId ? { systemId } : {}),
        },
        select: { id: true, appNo: true, deficiencyDue: true, systemId: true, system: { select: { addressLine: true } } },
      });
      return rows.map((r) => ({
        systemId: r.systemId,
        addressLine: r.system.addressLine,
        start: r.deficiencyDue!,
        dueOverride: r.deficiencyDue!,
        context: { app_no: r.appNo, enrollment_id: r.id },
      }));
    },
  },

  // 30-day turnover SLA; closes when the four artifacts are on file.
  turnover_sla: {
    todayRow: true,
    load: async (client, systemId) => {
      const rows = await client.turnoverCase.findMany({
        where: { closedAt: null, ...(systemId ? { systemId } : {}) },
        select: { id: true, systemId: true, openedAt: true, system: { select: { addressLine: true } } },
      });
      return rows.map((r) => ({
        systemId: r.systemId,
        addressLine: r.system.addressLine,
        start: r.openedAt,
        context: { turnover_id: r.id },
      }));
    },
  },

  // Fleet-wide annual window — one row, no system.
  li_allocation_window: {
    todayRow: true,
    load: async (_client, systemId) => {
      if (systemId) return []; // not a per-system clock
      const year = new Date().getUTCFullYear();
      const window = LI_WINDOW[year];
      if (!window) return [];
      return [
        {
          systemId: null,
          addressLine: null,
          start: new Date(`${window.open}T00:00:00Z`),
          dueOverride: new Date(`${window.close}T00:00:00Z`),
          context: { program_year: year, opens: window.open, closes: window.close },
        },
      ];
    },
  },

  // Event-driven, not countdowns. itc_recapture gates the REMOVED terminal
  // (02 §Terminal), workmanship stamps a ticket's warranty flag at open, and
  // esa_cancellation holds cgb_app_submitted (holds.ts). They are evaluated at
  // those moments, so they never queue a Today row.
  itc_recapture: { todayRow: false, load: async () => [] },
  workmanship: { todayRow: false, load: async () => [] },
  esa_cancellation: { todayRow: false, load: async () => [] },
};

/** Due date from the seed's length, unless the source row carried it. */
function dueDate(subject: Subject, clock: { lengthMonths: number | null; lengthDays: number | null }): Date | null {
  if (subject.dueOverride) return subject.dueOverride;
  if (clock.lengthMonths != null) return addMonths(subject.start, clock.lengthMonths);
  if (clock.lengthDays != null) return addDays(subject.start, clock.lengthDays);
  return null;
}

/**
 * Parse the seed's `warn_at` prose into a date. Supported forms:
 *   "18 mo" / "108 mo"  → start + N months
 *   "day 2" / "day 14"  → start + N days
 *   "60 d before close" → due - N days
 * Anything else ("on removal intent", "on ticket open") is event-driven and
 * yields null — such clocks never schedule a warning.
 */
export function warnDate(start: Date, due: Date | null, warnAt: string | null): Date | null {
  if (!warnAt) return null;
  const before = /(\d+)\s*d\w*\s+before/i.exec(warnAt);
  if (before) return due ? addDays(due, -Number(before[1])) : null;
  const months = /(\d+)\s*mo/i.exec(warnAt);
  if (months) return addMonths(start, Number(months[1]));
  const day = /day\s*(\d+)/i.exec(warnAt);
  if (day) return addDays(start, Number(day[1]));
  return null;
}

/** Start of a business-day clock walked back from its deadline. */
function businessStart(due: Date, lengthDays: number | null): Date {
  return lengthDays ? addBusinessDays(due, -lengthDays) : due;
}

/**
 * Evaluate every clock and return the ones now inside their warn window or
 * past due. `systemId` narrows to a single system (the on-write path).
 */
export async function evaluateClocks(systemId?: string, client: Client = prisma, now = new Date()): Promise<ClockHit[]> {
  const clocks = await client.clock.findMany();
  const hits: ClockHit[] = [];

  for (const clock of clocks) {
    const source = SOURCES[clock.key];
    if (!source || !source.todayRow) continue;

    const subjects = await source.load(client, systemId);
    for (const subject of subjects) {
      const due = dueDate(subject, clock);
      // cgb_deficiency counts in business days back from its deadline.
      const start = subject.dueOverride && clock.lengthDays ? businessStart(subject.dueOverride, clock.lengthDays) : subject.start;
      const warn = warnDate(start, due, clock.warnAt);
      if (!warn || now < warn) continue;

      hits.push({
        clock: clock.key,
        level: due && now >= due ? 'DUE' : 'WARN',
        systemId: subject.systemId,
        addressLine: subject.addressLine,
        startedAt: start,
        warnAt: warn,
        dueAt: due,
        daysToDue: due ? daysBetween(now, due) : null,
        consequence: clock.consequence,
        context: subject.context ?? {},
      });
    }
  }

  // Soonest deadline first; undated last.
  hits.sort((a, b) => (a.daysToDue ?? 1e9) - (b.daysToDue ?? 1e9));
  return hits;
}

/**
 * Log each crossing once. The guard is an `activity_log` row keyed by
 * (entity, entityId, action, meta.clock, meta.level), so re-running the sweep
 * — or a write that lands the same day — adds nothing and re-notifies nobody.
 */
export async function recordCrossings(hits: ClockHit[], client: Client = prisma): Promise<number> {
  let written = 0;
  for (const hit of hits) {
    const entity = hit.systemId ? 'system' : 'program';
    const entityId = hit.systemId ?? hit.clock;
    const existing = await client.activityLog.findFirst({
      where: {
        entity,
        entityId,
        action: 'clock',
        AND: [
          { meta: { path: ['clock'], equals: hit.clock } },
          { meta: { path: ['level'], equals: hit.level } },
        ],
      },
    });
    if (existing) continue;

    await client.activityLog.create({
      data: {
        entity,
        entityId,
        action: 'clock',
        actor: 'system',
        meta: {
          clock: hit.clock,
          level: hit.level,
          due_at: hit.dueAt?.toISOString() ?? null,
          days_to_due: hit.daysToDue,
        } as Prisma.InputJsonValue,
      },
    });
    notify.clockWatch(hit.systemId ?? hit.clock, `${hit.clock}:${hit.level.toLowerCase()}`);
    written += 1;
  }
  return written;
}

/** Cron pass over the whole fleet. */
export async function sweepClocks(now = new Date()) {
  const hits = await evaluateClocks(undefined, prisma, now);
  const logged = await recordCrossings(hits);
  return { evaluated: hits.length, logged, at: now };
}

/** On-write pass for one system, after a date field changes. */
export async function evaluateSystemClocks(systemId: string, client: Client = prisma) {
  const hits = await evaluateClocks(systemId, client);
  await recordCrossings(hits, client);
  return hits;
}
