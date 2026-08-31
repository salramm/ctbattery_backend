/**
 * P&L roll-up (03 §Money — "per-system NOI → property → fleet; export matches
 * the exit-calculator model format").
 *
 * This is the ledger read back, not a model. The exit calculator projects what a
 * system *should* earn; this reports what it has actually booked, in the same
 * column vocabulary so the two can be laid side by side:
 *
 *   itc_cash + enroll_amt + perf_pay  −  opex − service_cost  =  NOI
 *
 * Every figure traces to `ledger_entries` rows. Expected and received are kept
 * apart throughout — collapsing them would let a projection masquerade as
 * revenue, which is the one thing a ledger must never do (L7).
 */
import prisma from '../config/database';

/** Ledger types that are money in, and money out. */
const INFLOW = ['ENROLL_INC', 'PERF_PAY', 'ITC_CASH'] as const;
const OUTFLOW = ['OPEX', 'SERVICE_COST'] as const;

interface Bucket {
  enroll_inc: number;
  perf_pay: number;
  itc_cash: number;
  opex: number;
  service_cost: number;
}

const empty = (): Bucket => ({ enroll_inc: 0, perf_pay: 0, itc_cash: 0, opex: 0, service_cost: 0 });

const KEY: Record<string, keyof Bucket> = {
  ENROLL_INC: 'enroll_inc',
  PERF_PAY: 'perf_pay',
  ITC_CASH: 'itc_cash',
  OPEX: 'opex',
  SERVICE_COST: 'service_cost',
};

function noi(b: Bucket): number {
  return Number((b.enroll_inc + b.perf_pay + b.itc_cash - b.opex - b.service_cost).toFixed(2));
}

export interface PnlRow {
  system_id: string;
  address: string | null;
  property_id: string | null;
  property: string | null;
  tier: string | null;
  kw_rated: number | null;
  stage: string;
  expected: Bucket & { noi: number };
  received: Bucket & { noi: number };
  /** Booked-but-unpaid: what the ledger says is still owed. */
  outstanding: number;
}

export async function getPnl() {
  const [systems, entries] = await Promise.all([
    prisma.system.findMany({
      where: { terminalState: null },
      select: {
        id: true,
        addressLine: true,
        stage: true,
        tier: true,
        kwRated: true,
        propertyId: true,
        property: { select: { id: true, name: true, town: true } },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: { type: { in: [...INFLOW, ...OUTFLOW] } },
      select: { systemId: true, type: true, expectedAmt: true, receivedAmt: true },
    }),
  ]);

  const expectedBy = new Map<string, Bucket>();
  const receivedBy = new Map<string, Bucket>();
  for (const e of entries) {
    const key = KEY[e.type];
    if (!key) continue;
    const exp = expectedBy.get(e.systemId) ?? empty();
    const rec = receivedBy.get(e.systemId) ?? empty();
    exp[key] += e.expectedAmt == null ? 0 : Number(e.expectedAmt);
    rec[key] += e.receivedAmt == null ? 0 : Number(e.receivedAmt);
    expectedBy.set(e.systemId, exp);
    receivedBy.set(e.systemId, rec);
  }

  const rows: PnlRow[] = systems
    .filter((s) => expectedBy.has(s.id) || receivedBy.has(s.id))
    .map((s) => {
      const exp = expectedBy.get(s.id) ?? empty();
      const rec = receivedBy.get(s.id) ?? empty();
      return {
        system_id: s.id,
        address: s.addressLine,
        property_id: s.property?.id ?? null,
        property: s.property?.name ?? s.property?.town ?? null,
        tier: s.tier,
        kw_rated: s.kwRated == null ? null : Number(s.kwRated),
        stage: s.stage,
        expected: { ...exp, noi: noi(exp) },
        received: { ...rec, noi: noi(rec) },
        outstanding: Number(
          (
            exp.enroll_inc + exp.perf_pay + exp.itc_cash - (rec.enroll_inc + rec.perf_pay + rec.itc_cash)
          ).toFixed(2),
        ),
      };
    })
    .sort((a, b) => b.received.noi - a.received.noi);

  // ---- property roll-up ---------------------------------------------------
  const byProperty = new Map<string, { property_id: string; property: string | null; systems: number; expected: Bucket; received: Bucket }>();
  for (const r of rows) {
    const id = r.property_id ?? 'unassigned';
    const cur = byProperty.get(id) ?? { property_id: id, property: r.property, systems: 0, expected: empty(), received: empty() };
    cur.systems += 1;
    for (const k of Object.keys(empty()) as Array<keyof Bucket>) {
      cur.expected[k] += r.expected[k];
      cur.received[k] += r.received[k];
    }
    byProperty.set(id, cur);
  }
  const properties = [...byProperty.values()]
    .map((p) => ({ ...p, expected: { ...p.expected, noi: noi(p.expected) }, received: { ...p.received, noi: noi(p.received) } }))
    .sort((a, b) => b.received.noi - a.received.noi);

  // ---- fleet roll-up ------------------------------------------------------
  const fleetExpected = empty();
  const fleetReceived = empty();
  for (const r of rows) {
    for (const k of Object.keys(empty()) as Array<keyof Bucket>) {
      fleetExpected[k] += r.expected[k];
      fleetReceived[k] += r.received[k];
    }
  }

  return {
    systems: rows,
    properties,
    fleet: {
      systems: rows.length,
      expected: { ...fleetExpected, noi: noi(fleetExpected) },
      received: { ...fleetReceived, noi: noi(fleetReceived) },
      outstanding: Number(rows.reduce((n, r) => n + r.outstanding, 0).toFixed(2)),
    },
  };
}

/**
 * CSV export in the exit-calculator's column vocabulary, so a modelled system
 * and a real one line up row for row. Expected and received stay in separate
 * columns — the calculator's single figure is a projection, and this file has
 * to show which of ours is which.
 */
export async function exportPnlCsv(): Promise<string> {
  const { systems, fleet } = await getPnl();

  const header = [
    'system_id',
    'address',
    'property',
    'tier',
    'kw_rated',
    'stage',
    'enroll_amt_expected',
    'enroll_amt_received',
    'perf_expected',
    'perf_received',
    'itc_cash_expected',
    'itc_cash_received',
    'direct_opex',
    'service_cost',
    'annual_noi_expected',
    'annual_noi_received',
    'outstanding',
  ];

  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [header.join(',')];
  for (const r of systems) {
    lines.push(
      [
        r.system_id,
        r.address,
        r.property,
        r.tier,
        r.kw_rated,
        r.stage,
        r.expected.enroll_inc,
        r.received.enroll_inc,
        r.expected.perf_pay,
        r.received.perf_pay,
        r.expected.itc_cash,
        r.received.itc_cash,
        r.expected.opex,
        r.expected.service_cost,
        r.expected.noi,
        r.received.noi,
        r.outstanding,
      ]
        .map(esc)
        .join(','),
    );
  }
  lines.push(
    [
      'FLEET',
      '',
      '',
      '',
      '',
      '',
      fleet.expected.enroll_inc,
      fleet.received.enroll_inc,
      fleet.expected.perf_pay,
      fleet.received.perf_pay,
      fleet.expected.itc_cash,
      fleet.received.itc_cash,
      fleet.expected.opex,
      fleet.expected.service_cost,
      fleet.expected.noi,
      fleet.received.noi,
      fleet.outstanding,
    ]
      .map(esc)
      .join(','),
  );

  return lines.join('\n');
}
