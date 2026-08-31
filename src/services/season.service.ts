/**
 * Events, season close and statement reconciliation (03 §Money — Incentives;
 * 00 L7; 01 §Derived).
 *
 * L7 is the whole design here: **the season rollup IS the ledger row.** There
 * is no season-rollup table. Closing a season writes one `ledger_entries` row
 * per system (`PERF_PAY`, `season_id` set, `meta{events_n, avg_kw, rate,
 * share}` carrying the computation), and importing a statement writes
 * `received_amt`/`received_date` onto that same row. Receipt is a
 * reconciliation, not a discovery — the expected dollar was written the moment
 * it became knowable.
 *
 * Events are stored once (01 §events — "stored once; consumed by revenue,
 * health rules, derate calibration. Never duplicated"), and the telemetry store
 * is never folded into them; the Enlighten cross-check only *flags* a row.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, evaluateEventRules, readTelemetry } from '../lib/lifecycle';

/** 00 — season share is half the annual $/kW-yr locked rate, each season. */
export const SEASON_SHARE = 0.5;

/** L7 — receipt more than this off the expected amount flips VARIANCE. */
export const VARIANCE_THRESHOLD = 0.1;

// ==== CSV ===================================================================

/** Split a CSV into header + rows. Handles quoted fields and CRLF. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ==== events import =========================================================

export interface EventImportRow {
  system_id: string | null;
  matched_by: string | null;
  date: string;
  window: string | null;
  kw_nominated: number | null;
  kw_delivered: number | null;
  ratio: number | null;
  result: 'imported' | 'updated' | 'skipped';
  detail?: string;
  cross_check?: string;
  rules_fired?: string[];
}

/**
 * Import an EnergyHub dispatch CSV into `events`.
 *
 * Column mapping (case/spacing-insensitive):
 *   site_id | derms_id | enlighten_site_id | system_id → the system
 *   event_date | date                                  → date
 *   window | event_window                              → window
 *   kw_nominated | nominated_kw                        → kw_nominated
 *   kw_delivered | delivered_kw                        → kw_delivered
 *   soc_start                                          → soc_start
 *
 * `ratio` is computed, never trusted from the file. The unique
 * (system_id, date, window) makes a re-import an update, not a duplicate.
 *
 * The Enlighten cross-check compares the row against the telemetry store and
 * flags a disagreement — it never rewrites the dispatch number, because the two
 * sources answer different questions.
 */
export async function importEvents(csv: string, opts: { seasonId?: string; crossCheck?: boolean; by?: string | null } = {}) {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new LifecycleError(400, 'EMPTY_CSV', 'No rows found in the file');

  // Resolve the identifiers the file might use, in one pass.
  const systems = await prisma.system.findMany({
    select: { id: true, dermsId: true, enlightenSiteId: true, addressLine: true, enrollments: { select: { appNo: true } } },
  });
  const byDerms = new Map(systems.filter((s) => s.dermsId).map((s) => [s.dermsId as string, s]));
  const bySite = new Map(systems.filter((s) => s.enlightenSiteId).map((s) => [s.enlightenSiteId as string, s]));
  const byId = new Map(systems.map((s) => [s.id, s]));

  const seasons = await prisma.season.findMany();

  const results: EventImportRow[] = [];
  const touched: string[] = [];

  for (const r of rows) {
    const key = r.system_id || r.derms_id || r.site_id || r.enlighten_site_id || '';
    const match = byId.get(key) ?? byDerms.get(key) ?? bySite.get(key) ?? null;
    const dateStr = r.event_date || r.date || '';
    const windowStr = r.window || r.event_window || null;

    const base: EventImportRow = {
      system_id: match?.id ?? null,
      matched_by: match ? (byId.has(key) ? 'system_id' : byDerms.has(key) ? 'derms_id' : 'enlighten_site_id') : null,
      date: dateStr,
      window: windowStr,
      kw_nominated: num(r.kw_nominated ?? r.nominated_kw),
      kw_delivered: num(r.kw_delivered ?? r.delivered_kw),
      ratio: null,
      result: 'skipped',
    };

    if (!match) {
      results.push({ ...base, detail: `no system matches "${key}"` });
      continue;
    }
    const date = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      results.push({ ...base, detail: `unparseable date "${dateStr}"` });
      continue;
    }

    const nominated = base.kw_nominated;
    const delivered = base.kw_delivered;
    const ratio = nominated && nominated > 0 && delivered != null ? delivered / nominated : null;

    // Pick the season whose window contains the date, unless one was given.
    const seasonId =
      opts.seasonId ??
      seasons.find((s) => {
        const w = s.window as { start?: string; end?: string } | null;
        if (!w?.start || !w?.end) return false;
        return dateStr >= w.start && dateStr <= w.end;
      })?.id ??
      null;

    // `window` is nullable, and Prisma's compound-unique input will not accept a
    // null there (NULL never equals NULL in SQL), so match on the columns.
    const existing = await prisma.event.findFirst({
      where: { systemId: match.id, date, window: windowStr },
    });

    const data = {
      seasonId,
      kwNominated: nominated,
      kwDelivered: delivered,
      ratio,
      socStart: num(r.soc_start),
      online: delivered != null ? delivered > 0 : null,
      source: 'ENERGYHUB_CSV' as const,
    };

    const event = existing
      ? await prisma.event.update({ where: { id: existing.id }, data })
      : await prisma.event.create({ data: { systemId: match.id, date, window: windowStr, ...data } });

    const row: EventImportRow = {
      ...base,
      ratio,
      result: existing ? 'updated' : 'imported',
    };

    // Event-driven alert rules run on ingestion (P7's hook).
    row.rules_fired = await evaluateEventRules(event.id);
    results.push(row);
    touched.push(match.id);
  }

  // Enlighten cross-check: did the fleet's own telemetry see the system online?
  if (opts.crossCheck !== false && touched.length) {
    const flagged = await crossCheckEvents(results);
    for (const f of flagged) {
      const target = results.find((r) => r.system_id === f.systemId && r.date === f.date);
      if (target) target.cross_check = f.note;
    }
  }

  const imported = results.filter((r) => r.result === 'imported').length;
  const updated = results.filter((r) => r.result === 'updated').length;

  await prisma.activityLog.create({
    data: {
      entity: 'program',
      entityId: 'events_import',
      action: 'events_import',
      actor: opts.by ?? null,
      meta: { rows: rows.length, imported, updated, skipped: results.length - imported - updated } as Prisma.InputJsonValue,
    },
  });

  return { rows: rows.length, imported, updated, skipped: results.length - imported - updated, results };
}

/**
 * Flag rows the telemetry store disagrees with: dispatch says the system
 * delivered, Enlighten says it was dark (or vice versa). The flag is a note on
 * the import result and an `ENLIGHTEN_XCHECK` marker — the dispatch figure is
 * left exactly as the program reported it.
 */
async function crossCheckEvents(results: EventImportRow[]): Promise<Array<{ systemId: string; date: string; note: string }>> {
  const ids = [...new Set(results.map((r) => r.system_id).filter((v): v is string => Boolean(v)))];
  if (!ids.length) return [];

  const systems = await prisma.system.findMany({
    where: { id: { in: ids } },
    select: { id: true, enlightenSiteId: true, fwVersion: true },
  });
  const reads = await readTelemetry(systems, prisma);
  const flags: Array<{ systemId: string; date: string; note: string }> = [];

  for (const r of results) {
    if (!r.system_id || r.result === 'skipped') continue;
    const read = reads.get(r.system_id);
    if (!read?.siteId) {
      flags.push({ systemId: r.system_id, date: r.date, note: 'no Enlighten site linked — not cross-checked' });
      continue;
    }
    if ((r.kw_delivered ?? 0) > 0 && read.hoursSinceSeen != null && read.hoursSinceSeen > 24) {
      flags.push({
        systemId: r.system_id,
        date: r.date,
        note: `dispatch reports ${r.kw_delivered} kW but Enlighten has not seen this site in ${Math.round(read.hoursSinceSeen)}h`,
      });
    }
    if ((r.kw_delivered ?? 0) === 0 && read.hoursSinceSeen != null && read.hoursSinceSeen < 4) {
      flags.push({
        systemId: r.system_id,
        date: r.date,
        note: 'dispatch reports 0 kW but Enlighten shows the site reporting — check the dispatch mapping',
      });
    }
  }

  // Mark the cross-checked rows so provenance survives in the data, not just
  // in the import report.
  for (const f of flags) {
    const date = new Date(`${f.date}T00:00:00Z`);
    await prisma.event.updateMany({
      where: { systemId: f.systemId, date },
      data: { source: 'ENLIGHTEN_XCHECK' },
    });
  }
  return flags;
}

// ==== season close ==========================================================

export interface SeasonCloseRow {
  system_id: string;
  address: string | null;
  events_n: number;
  avg_kw: number;
  rate: number | null;
  share: number;
  expected_amt: number | null;
  result: 'written' | 'updated' | 'skipped';
  detail?: string;
}

/**
 * Close a season: write one PERF_PAY ledger row per system that participated.
 *
 * expected = share × annual_rate × AVG(kw_delivered)   (01 §Derived, 00 L7)
 *
 * Idempotent: re-closing updates the same row rather than booking the revenue
 * twice. The season's own status moves to CLOSED.
 */
export async function closeSeason(seasonId: string, opts: { by?: string | null; force?: boolean } = {}) {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) throw new LifecycleError(404, 'SEASON_NOT_FOUND', `No season ${seasonId}`);
  if (season.status === 'RECONCILED' && !opts.force) {
    throw new LifecycleError(409, 'SEASON_RECONCILED', 'This season is already reconciled; pass force to recompute');
  }

  const events = await prisma.event.findMany({
    where: { seasonId, kwDelivered: { not: null } },
    include: { system: { select: { id: true, addressLine: true, lockedRates: true } } },
  });

  const bySystem = new Map<string, typeof events>();
  for (const e of events) {
    const arr = bySystem.get(e.systemId) ?? [];
    arr.push(e);
    bySystem.set(e.systemId, arr);
  }

  const rows: SeasonCloseRow[] = [];

  for (const [systemId, list] of bySystem) {
    const system = list[0].system;
    const delivered = list.map((e) => Number(e.kwDelivered));
    const avgKw = delivered.reduce((a, b) => a + b, 0) / delivered.length;
    const rates = system.lockedRates as { annual_rate?: number | null } | null;
    const rate = rates?.annual_rate ?? null;

    const base: SeasonCloseRow = {
      system_id: systemId,
      address: system.addressLine,
      events_n: list.length,
      avg_kw: Number(avgKw.toFixed(4)),
      rate,
      share: SEASON_SHARE,
      expected_amt: null,
      result: 'skipped',
    };

    if (rate == null) {
      // No locked rate means no contracted price — booking a number here would
      // be inventing revenue.
      rows.push({ ...base, detail: 'no locked_rates.annual_rate — rate locks at ROF' });
      continue;
    }

    const expected = Number((SEASON_SHARE * rate * avgKw).toFixed(2));
    const existing = await prisma.ledgerEntry.findFirst({ where: { systemId, seasonId, type: 'PERF_PAY' } });

    const meta = { events_n: list.length, avg_kw: Number(avgKw.toFixed(4)), rate, share: SEASON_SHARE };
    if (existing) {
      await prisma.ledgerEntry.update({
        where: { id: existing.id },
        data: { expectedAmt: expected, expectedDate: seasonEnd(season.window), meta: meta as Prisma.InputJsonValue },
      });
    } else {
      await prisma.ledgerEntry.create({
        data: {
          systemId,
          seasonId,
          type: 'PERF_PAY',
          status: 'EXPECTED',
          expectedAmt: expected,
          expectedDate: seasonEnd(season.window),
          meta: meta as Prisma.InputJsonValue,
        },
      });
    }

    rows.push({ ...base, expected_amt: expected, result: existing ? 'updated' : 'written' });
  }

  await prisma.season.update({ where: { id: seasonId }, data: { status: 'CLOSED' } });
  await prisma.activityLog.create({
    data: {
      entity: 'program',
      entityId: seasonId,
      action: 'season_close',
      actor: opts.by ?? null,
      meta: { systems: rows.length, written: rows.filter((r) => r.result !== 'skipped').length } as Prisma.InputJsonValue,
    },
  });

  return {
    season: { id: season.id, name: season.name, program_year: season.programYear },
    systems: rows.length,
    written: rows.filter((r) => r.result === 'written').length,
    updated: rows.filter((r) => r.result === 'updated').length,
    skipped: rows.filter((r) => r.result === 'skipped').length,
    total_expected: Number(rows.reduce((n, r) => n + (r.expected_amt ?? 0), 0).toFixed(2)),
    rows,
  };
}

function seasonEnd(window: unknown): Date | null {
  const w = window as { end?: string } | null;
  return w?.end ? new Date(`${w.end}T00:00:00Z`) : null;
}

// ==== statement reconciliation ==============================================

export interface StatementRow {
  system_id: string | null;
  ledger_id: string | null;
  expected: number | null;
  received: number | null;
  variance_pct: number | null;
  status: string;
  result: 'reconciled' | 'variance' | 'skipped';
  detail?: string;
}

/**
 * Import a program statement CSV and reconcile it against the expected rows.
 *
 * Columns: system_id | derms_id | app_no → the system; amount | received_amt →
 * the payment; paid_date | received_date → when.
 *
 * Reconciliation writes onto the SAME PERF_PAY row (L7 — no separate receipts
 * table). A gap of more than 10% flips `status=VARIANCE`, which is what puts it
 * on Today; anything inside tolerance is RECEIVED.
 */
export async function importStatement(
  csv: string,
  opts: { seasonId?: string; by?: string | null } = {},
) {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new LifecycleError(400, 'EMPTY_CSV', 'No rows found in the file');

  const systems = await prisma.system.findMany({
    select: { id: true, dermsId: true, cgbAppNo: true, addressLine: true },
  });
  const byId = new Map(systems.map((s) => [s.id, s]));
  const byDerms = new Map(systems.filter((s) => s.dermsId).map((s) => [s.dermsId as string, s]));
  const byApp = new Map(systems.filter((s) => s.cgbAppNo).map((s) => [s.cgbAppNo as string, s]));

  const results: StatementRow[] = [];

  for (const r of rows) {
    const key = r.system_id || r.derms_id || r.app_no || '';
    const match = byId.get(key) ?? byDerms.get(key) ?? byApp.get(key) ?? null;
    const received = num(r.amount ?? r.received_amt ?? r.paid_amount);
    const receivedDate = r.paid_date || r.received_date || null;

    if (!match) {
      results.push({ system_id: null, ledger_id: null, expected: null, received, variance_pct: null, status: '—', result: 'skipped', detail: `no system matches "${key}"` });
      continue;
    }
    if (received == null) {
      results.push({ system_id: match.id, ledger_id: null, expected: null, received: null, variance_pct: null, status: '—', result: 'skipped', detail: 'no amount on the statement row' });
      continue;
    }

    const entry = await prisma.ledgerEntry.findFirst({
      where: { systemId: match.id, type: 'PERF_PAY', ...(opts.seasonId ? { seasonId: opts.seasonId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (!entry) {
      results.push({ system_id: match.id, ledger_id: null, expected: null, received, variance_pct: null, status: '—', result: 'skipped', detail: 'no expected PERF_PAY row — close the season first' });
      continue;
    }

    const expected = entry.expectedAmt == null ? null : Number(entry.expectedAmt);
    const variance = expected && expected !== 0 ? (received - expected) / expected : null;
    const isVariance = variance != null && Math.abs(variance) > VARIANCE_THRESHOLD;
    const status = isVariance ? 'VARIANCE' : 'RECEIVED';

    await prisma.ledgerEntry.update({
      where: { id: entry.id },
      data: {
        receivedAmt: received,
        receivedDate: receivedDate ? new Date(`${receivedDate}T00:00:00Z`) : new Date(),
        status,
        meta: {
          ...((entry.meta as Record<string, unknown>) ?? {}),
          variance_pct: variance == null ? null : Number((variance * 100).toFixed(2)),
        } as Prisma.InputJsonValue,
      },
    });

    results.push({
      system_id: match.id,
      ledger_id: entry.id,
      expected,
      received,
      variance_pct: variance == null ? null : Number((variance * 100).toFixed(2)),
      status,
      result: isVariance ? 'variance' : 'reconciled',
    });
  }

  // A fully reconciled season is RECONCILED; any variance leaves it CLOSED.
  if (opts.seasonId) {
    const outstanding = await prisma.ledgerEntry.count({
      where: { seasonId: opts.seasonId, type: 'PERF_PAY', OR: [{ receivedAmt: null }, { status: 'VARIANCE' }] },
    });
    if (outstanding === 0) await prisma.season.update({ where: { id: opts.seasonId }, data: { status: 'RECONCILED' } });
  }

  const variances = results.filter((r) => r.result === 'variance').length;
  await prisma.activityLog.create({
    data: {
      entity: 'program',
      entityId: opts.seasonId ?? 'statement',
      action: 'statement_import',
      actor: opts.by ?? null,
      meta: { rows: rows.length, reconciled: results.filter((r) => r.result === 'reconciled').length, variances } as Prisma.InputJsonValue,
    },
  });

  return {
    rows: rows.length,
    reconciled: results.filter((r) => r.result === 'reconciled').length,
    variances,
    skipped: results.filter((r) => r.result === 'skipped').length,
    results,
  };
}

/** The Incentives desk: enrollment + seasonal rows, expected vs received. */
export async function getIncentives() {
  const [entries, seasons] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { type: { in: ['ENROLL_INC', 'PERF_PAY'] } },
      include: { system: { select: { addressLine: true, property: { select: { name: true } } } }, season: true },
      orderBy: [{ expectedDate: 'desc' }],
    }),
    prisma.season.findMany({ orderBy: [{ programYear: 'desc' }, { name: 'asc' }] }),
  ]);

  const rows = entries.map((e) => {
    const expected = e.expectedAmt == null ? null : Number(e.expectedAmt);
    const received = e.receivedAmt == null ? null : Number(e.receivedAmt);
    return {
      id: e.id,
      system_id: e.systemId,
      address: e.system.addressLine,
      property: e.system.property?.name ?? null,
      type: e.type,
      season: e.season ? `${e.season.name} ${e.season.programYear}` : null,
      expected_amt: expected,
      expected_date: e.expectedDate,
      received_amt: received,
      received_date: e.receivedDate,
      variance_pct:
        expected && received != null && expected !== 0 ? Number((((received - expected) / expected) * 100).toFixed(2)) : null,
      status: e.status,
      meta: e.meta,
    };
  });

  return {
    seasons: seasons.map((s) => ({ id: s.id, name: s.name, program_year: s.programYear, window: s.window, status: s.status })),
    rows,
    totals: {
      expected: Number(rows.reduce((n, r) => n + (r.expected_amt ?? 0), 0).toFixed(2)),
      received: Number(rows.reduce((n, r) => n + (r.received_amt ?? 0), 0).toFixed(2)),
      variances: rows.filter((r) => r.status === 'VARIANCE').length,
    },
  };
}
