/**
 * Today — the action queue (03 §Today).
 *
 * Server-composed from live tables, five sections in priority order. Every row
 * carries exactly one primary action and no charts; empty sections are dropped
 * so the client renders only what needs a human. Nothing here is cached or
 * materialised — clear the underlying condition and the row is gone on the next
 * compose, which is the whole contract.
 */
import prisma from '../config/database';
import { evaluateClocks, daysBetween, type ClockHit } from '../lib/lifecycle';

/** One action. `href` is a portal route; `endpoint` is set when it mutates. */
export interface RowAction {
  label: string;
  href?: string;
  endpoint?: string;
  method?: 'POST' | 'PATCH';
}

export interface TodayRow {
  id: string;
  system_id: string | null;
  address: string | null;
  label: string;
  detail: string;
  /** Mono metric shown at the row's right edge — an age or a countdown. */
  metric: string;
  severity: 'FAULT' | 'WATCH' | 'DUE' | 'INFO';
  action: RowAction;
}

export interface TodaySection {
  key: string;
  title: string;
  rows: TodayRow[];
}

const systemHref = (id: string) => `/portal/systems?id=${id}`;

function ageLabel(days: number): string {
  return `${days}d`;
}

// ==== 1. Health alerts ======================================================
// Open FAULT first, then WATCH. [Open ticket] when nothing is tracking it yet,
// [View] once a ticket exists — the slash in 03 is a state, not two buttons.
async function healthAlerts(now: Date): Promise<TodayRow[]> {
  const alerts = await prisma.alert.findMany({
    where: { clearedAt: null, system: { terminalState: null } },
    include: { rule: true, system: { select: { addressLine: true } } },
  });

  return alerts
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'FAULT' ? -1 : 1;
      return a.openedAt.getTime() - b.openedAt.getTime();
    })
    .map((a) => ({
      id: `alert:${a.id}`,
      system_id: a.systemId,
      address: a.system.addressLine,
      label: a.rule?.triggerDesc ?? a.ruleKey ?? 'Alert',
      detail: a.rule?.autoAction ?? '',
      metric: ageLabel(daysBetween(a.openedAt, now)),
      severity: a.severity === 'FAULT' ? 'FAULT' : 'WATCH',
      action: a.ticketId
        ? { label: 'View', href: `/portal/service?ticket=${a.ticketId}` }
        : {
            label: 'Open ticket',
            href: systemHref(a.systemId),
            endpoint: `/api/alerts/${a.id}/ticket`,
            method: 'POST' as const,
          },
    }));
}

// ==== 2. Blocked cards ======================================================
// A block earns a Today row once it is older than its code's today_after_days
// (01 §Seed — blocked codes; default 3). Oldest first.
async function blockedCards(now: Date): Promise<TodayRow[]> {
  const systems = await prisma.system.findMany({
    where: { blockedCode: { not: null }, terminalState: null },
    include: { blockedCodeRef: true },
  });

  return systems
    .map((s) => {
      const threshold = s.blockedCodeRef?.todayAfterDays ?? 3;
      const age = s.blockedAt ? daysBetween(s.blockedAt, now) : 0;
      return { s, threshold, age };
    })
    .filter(({ age, threshold }) => age >= threshold)
    .sort((a, b) => b.age - a.age)
    .map(({ s, age, threshold }) => ({
      id: `blocked:${s.id}`,
      system_id: s.id,
      address: s.addressLine,
      label: s.blockedCode!,
      detail: [s.blockedCodeRef?.label, s.blockedNote].filter(Boolean).join(' — ') || `Blocked ${age}d (Today after ${threshold}d)`,
      metric: ageLabel(age),
      severity: 'WATCH' as const,
      action: { label: 'Open', href: systemHref(s.id) },
    }));
}

// ==== 3. Deadline countdowns ================================================
const CLOCK_TITLE: Record<string, string> = {
  rof_build: 'ROF build window',
  cgb_deficiency: 'CGB deficiency',
  performance_term: 'Performance term',
  turnover_sla: 'Turnover SLA',
  li_allocation_window: '48E(h) LI allocation window',
};

function clockRow(hit: ClockHit): TodayRow {
  const overdue = hit.daysToDue != null && hit.daysToDue < 0;
  return {
    id: `clock:${hit.clock}:${hit.systemId ?? 'program'}`,
    system_id: hit.systemId,
    address: hit.addressLine,
    label: CLOCK_TITLE[hit.clock] ?? hit.clock,
    detail: hit.consequence ?? '',
    metric:
      hit.daysToDue == null ? '—' : overdue ? `${Math.abs(hit.daysToDue)}d over` : `${hit.daysToDue}d left`,
    severity: hit.level === 'DUE' ? 'DUE' : 'WATCH',
    action: hit.systemId
      ? { label: 'Open', href: systemHref(hit.systemId) }
      : { label: 'Open ITC desk', href: '/portal/money?desk=itc' },
  };
}

// ==== 4. Signatures out =====================================================
// DocuSign envelopes still unsigned more than 48h after they went out. Fresh
// ones get [Resend]; once an envelope is two weeks stale, resending is not the
// move any more — [Void] and reissue.
const SIGNATURE_STALE_DAYS = 14;

async function signaturesOut(now: Date): Promise<TodayRow[]> {
  const cutoff = new Date(now.getTime() - 48 * 3600 * 1000);
  const docs = await prisma.document.findMany({
    where: {
      envelopeId: { not: null },
      status: { in: ['DRAFT', 'SENT'] },
      signedAt: null,
      createdAt: { lt: cutoff },
    },
    include: { system: { select: { addressLine: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return docs.map((d) => {
    const age = daysBetween(d.createdAt, now);
    return {
      id: `doc:${d.id}`,
      system_id: d.systemId,
      address: d.system?.addressLine ?? null,
      label: d.type,
      detail: `${d.title ?? 'Envelope'} · ${d.envelopeId}`,
      metric: ageLabel(age),
      severity: 'WATCH' as const,
      action:
        age >= SIGNATURE_STALE_DAYS
          ? { label: 'Void', endpoint: `/api/documents/${d.id}/void`, method: 'POST' as const }
          : { label: 'Resend', endpoint: `/api/documents/${d.id}/resend`, method: 'POST' as const },
    };
  });
}

// ==== 5. Money variances ====================================================
// Explicit VARIANCE rows, plus anything expected that never arrived.
async function moneyVariances(now: Date): Promise<TodayRow[]> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await prisma.ledgerEntry.findMany({
    where: {
      OR: [
        { status: 'VARIANCE' },
        { status: { not: 'RECEIVED' }, receivedAmt: null, expectedDate: { lt: today } },
      ],
    },
    include: { system: { select: { addressLine: true } } },
    orderBy: { expectedDate: 'asc' },
  });

  return rows.map((r) => {
    const overdueDays = r.expectedDate ? daysBetween(r.expectedDate, now) : null;
    const expected = r.expectedAmt ? `$${Number(r.expectedAmt).toLocaleString('en-US')}` : '—';
    return {
      id: `ledger:${r.id}`,
      system_id: r.systemId,
      address: r.system.addressLine,
      label: r.type,
      detail:
        r.status === 'VARIANCE'
          ? `Variance — expected ${expected}, received ${r.receivedAmt ? `$${Number(r.receivedAmt).toLocaleString('en-US')}` : 'nothing'}`
          : `Expected ${expected}, no receipt`,
      metric: overdueDays != null && overdueDays > 0 ? `${overdueDays}d over` : expected,
      severity: r.status === 'VARIANCE' ? 'DUE' : 'WATCH',
      action: { label: 'Open ledger', href: `/portal/money?system=${r.systemId}` },
    };
  });
}

// ==== D8 — the date block ===================================================
/** Server clock, rendered America/New_York (05-UI-DELTA D8). */
export function todayBlock(now = new Date()) {
  const tz = 'America/New_York';
  const part = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(now);
  return {
    weekday: part({ weekday: 'long' }),
    date: part({ month: 'short', day: 'numeric', year: 'numeric' }),
    time: part({ hour: '2-digit', minute: '2-digit', hour12: false }),
    tz: 'ET',
    iso: now.toISOString(),
  };
}

// ==== compose ===============================================================
export async function composeToday(now = new Date()) {
  const clockHits = await evaluateClocks(undefined, prisma, now);

  const sections: TodaySection[] = [
    { key: 'health', title: 'Health alerts', rows: await healthAlerts(now) },
    { key: 'blocked', title: 'Blocked cards', rows: await blockedCards(now) },
    { key: 'deadlines', title: 'Deadline countdowns', rows: clockHits.map(clockRow) },
    { key: 'signatures', title: 'Signatures out', rows: await signaturesOut(now) },
    { key: 'money', title: 'Money variances', rows: await moneyVariances(now) },
  ];

  // Empty sections collapse — the queue shows only what needs a human.
  const populated = sections.filter((s) => s.rows.length > 0);
  return {
    date: todayBlock(now),
    total: populated.reduce((n, s) => n + s.rows.length, 0),
    sections: populated,
  };
}
