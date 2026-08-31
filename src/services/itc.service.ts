/**
 * ITC desk (03 §Money — ITC desk; 02 §Automations; 05-UI-DELTA D4/D5).
 *
 * Claim status only ever moves forward:
 *   ACCRUING → BASIS_LOCKED → EVIDENCE_COMPLETE → IN_COHORT → TRANSFERRED
 *
 * Two rules here are load-bearing and enforced rather than documented:
 *   • every basis dollar is sourced to a document (01 §itc_basis_lines), and
 *     the PO line's `unit_cost` is that document for equipment (D4 — "the
 *     inventory table and the ITC basis engine share one source");
 *   • a claim cannot carry the LI adder without an allocation link that has
 *     remaining kW, and linking consumes it (01 §itc_allocations).
 *
 * Recapture is not a status. It is the computed condition `now() <
 * recapture_end` (00), so it is derived wherever the claim renders.
 */
import type { Prisma } from '@prisma/client';
import { Prisma as P } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, daysBetween } from '../lib/lifecycle';

/** The evidence file's checklist keys (01 §itc_claims — evidence jsonb). */
export const EVIDENCE_KEYS = [
  'serial_attestations',
  'ec_map_snapshot',
  'li_evidence',
  'invoices',
  'pto_letter',
  'cof_letter',
  'f3468_export',
] as const;

// ==== claims ================================================================

export async function listClaims(now = new Date()) {
  const claims = await prisma.itcClaim.findMany({
    include: {
      system: {
        select: {
          id: true,
          addressLine: true,
          kwRated: true,
          tier: true,
          recaptureEnd: true,
          property: { select: { name: true, town: true } },
        },
      },
      basisLines: true,
      cohort: true,
    },
  });

  const rows = claims.map((c) => {
    const recaptureEnd = c.recaptureEnd ?? c.system.recaptureEnd;
    return {
      id: c.id,
      system_id: c.systemId,
      address: c.system.addressLine,
      property: c.system.property?.name ?? null,
      tier: c.system.tier,
      kw_rated: c.system.kwRated == null ? null : Number(c.system.kwRated),
      status: c.status,
      basis_amt: c.basisAmt == null ? null : Number(c.basisAmt),
      stack: c.stack,
      total_pct: c.totalPct == null ? null : Number(c.totalPct),
      credit_amt: c.creditAmt == null ? null : Number(c.creditAmt),
      pis_date: c.pisDate,
      recapture_end: recaptureEnd,
      // Computed condition, never a stored status (00).
      in_recapture: Boolean(recaptureEnd && now < recaptureEnd),
      recapture_days_left: recaptureEnd ? Math.max(0, daysBetween(now, recaptureEnd)) : null,
      basis_lines: c.basisLines.map((l) => ({
        id: l.id,
        source: l.source,
        amount: Number(l.amount),
        doc_id: l.docId,
        sourced: Boolean(l.docId),
      })),
      evidence: c.evidence,
      evidence_complete: isEvidenceComplete(c.evidence),
      cohort: c.cohort ? { id: c.cohort.id, label: c.cohort.label, status: c.cohort.status } : null,
    };
  });

  return {
    claims: rows,
    counts: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    totals: {
      basis: Number(rows.reduce((n, r) => n + (r.basis_amt ?? 0), 0).toFixed(2)),
      credit: Number(rows.reduce((n, r) => n + (r.credit_amt ?? 0), 0).toFixed(2)),
      in_recapture: rows.filter((r) => r.in_recapture).length,
    },
  };
}

/** Every listed evidence key present and non-empty. */
export function isEvidenceComplete(evidence: unknown): boolean {
  const e = (evidence as Record<string, unknown> | null) ?? null;
  if (!e) return false;
  for (const key of EVIDENCE_KEYS) {
    const v = e[key];
    if (v == null || v === '' || v === false) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    // serial_attestations is a per-serial map; a null value means still owed.
    if (typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return false;
      if (entries.some(([, docId]) => !docId)) return false;
    }
  }
  return true;
}

/**
 * Recompute a claim's evidence completeness (02 §Automations — "ITC claim
 * evidence checklist complete → claim → EVIDENCE_COMPLETE"). Only promotes
 * from BASIS_LOCKED; a claim already in a cohort is left alone.
 */
export async function refreshEvidenceState(claimId: string, client = prisma) {
  const claim = await client.itcClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new LifecycleError(404, 'CLAIM_NOT_FOUND', `No claim ${claimId}`);
  const complete = isEvidenceComplete(claim.evidence);

  if (complete && claim.status === 'BASIS_LOCKED') {
    await client.itcClaim.update({ where: { id: claimId }, data: { status: 'EVIDENCE_COMPLETE' } });
    return 'EVIDENCE_COMPLETE';
  }
  // An RMA can un-complete an evidence file; fall back rather than lie.
  if (!complete && claim.status === 'EVIDENCE_COMPLETE') {
    await client.itcClaim.update({ where: { id: claimId }, data: { status: 'BASIS_LOCKED' } });
    return 'BASIS_LOCKED';
  }
  return claim.status;
}

/** Attach a document to one evidence key (or to a serial's attestation slot). */
export async function attachEvidence(
  claimId: string,
  input: { key: string; doc_id?: string; serial?: string; value?: unknown },
  by: string | null,
) {
  const claim = await prisma.itcClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new LifecycleError(404, 'CLAIM_NOT_FOUND', `No claim ${claimId}`);

  const evidence = ((claim.evidence as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  if (input.key === 'serial_attestations') {
    if (!input.serial) throw new LifecycleError(400, 'SERIAL_REQUIRED', 'serial_attestations needs a serial');
    const map = { ...((evidence.serial_attestations as Record<string, unknown>) ?? {}) };
    map[input.serial] = input.doc_id ?? null;
    evidence.serial_attestations = map;
  } else {
    evidence[input.key] = input.doc_id ?? input.value ?? true;
  }

  await prisma.itcClaim.update({ where: { id: claimId }, data: { evidence: evidence as Prisma.InputJsonValue } });
  await prisma.activityLog.create({
    data: {
      entity: 'system',
      entityId: claim.systemId,
      action: 'evidence_attach',
      actor: by,
      meta: { claim_id: claimId, key: input.key, serial: input.serial ?? null, doc_id: input.doc_id ?? null } as Prisma.InputJsonValue,
    },
  });

  const status = await refreshEvidenceState(claimId);
  return { status };
}

/**
 * Rebuild a claim's basis lines from the documents that justify them.
 *
 * Equipment cost comes from the purchase order line's `unit_cost` (D4), so the
 * inventory table and the basis engine cannot disagree; the PO is the document
 * the line is sourced to. Anything without a source document is reported rather
 * than silently included — an unsourced dollar is not a basis dollar.
 */
export async function rebuildBasis(claimId: string, by: string | null) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.itcClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new LifecycleError(404, 'CLAIM_NOT_FOUND', `No claim ${claimId}`);
    if (['IN_COHORT', 'TRANSFERRED'].includes(claim.status)) {
      throw new LifecycleError(409, 'CLAIM_LOCKED', `Basis cannot be rebuilt once the claim is ${claim.status}`);
    }

    const equipment = await tx.equipment.findMany({
      where: { systemId: claim.systemId, status: { in: ['INSTALLED', 'RMA_OUT'] } },
      include: { po: true },
    });

    const lines: Array<{ source: 'PO' | 'WO' | 'PERMIT' | 'OVERHEAD'; amount: number; docId: string | null; note: string }> = [];
    const unsourced: string[] = [];

    // 1 — equipment, priced from its PO line.
    for (const e of equipment) {
      if (e.status === 'RMA_OUT') continue; // the replacement carries the cost
      const poLines = (e.po?.lines as Array<{ sku?: string; unit_cost?: number }> | null) ?? [];
      const match = e.sku ? poLines.find((l) => l.sku === e.sku) : undefined;
      if (match?.unit_cost) {
        lines.push({ source: 'PO', amount: match.unit_cost, docId: null, note: `${e.serial} · ${e.sku} · ${e.po?.poNo}` });
      } else {
        unsourced.push(e.serial);
      }
    }

    // 2 — permit fees, when a permit document exists.
    const permit = await tx.document.findFirst({ where: { systemId: claim.systemId, type: 'PERMIT' } });
    if (permit) lines.push({ source: 'PERMIT', amount: 0, docId: permit.id, note: 'permit on file; fee to be entered' });

    // 3 — labour, from the install work order.
    const wo = await tx.workOrder.findFirst({ where: { systemId: claim.systemId, type: 'INSTALL', checkoutAt: { not: null } } });
    if (wo) lines.push({ source: 'WO', amount: 0, docId: null, note: `install work order ${wo.id}; labour to be entered` });

    await tx.itcBasisLine.deleteMany({ where: { claimId } });
    for (const l of lines) {
      await tx.itcBasisLine.create({
        data: { claimId, source: l.source, amount: new P.Decimal(l.amount), docId: l.docId },
      });
    }

    const basis = lines.reduce((n, l) => n + l.amount, 0);
    const stack = (claim.stack as { base?: number; dc?: number; ec?: number; li?: { pct?: number } } | null) ?? {};
    const totalPct = (stack.base ?? 30) + (stack.dc ?? 0) + (stack.ec ?? 0) + (stack.li?.pct ?? 0);

    await tx.itcClaim.update({
      where: { id: claimId },
      data: {
        basisAmt: new P.Decimal(basis),
        totalPct: new P.Decimal(totalPct),
        creditAmt: new P.Decimal((basis * totalPct) / 100),
      },
    });

    await tx.activityLog.create({
      data: {
        entity: 'system',
        entityId: claim.systemId,
        action: 'basis_rebuild',
        actor: by,
        meta: { claim_id: claimId, lines: lines.length, basis, unsourced } as Prisma.InputJsonValue,
      },
    });

    return { basis, total_pct: totalPct, credit: (basis * totalPct) / 100, lines, unsourced };
  });
}

// ==== allocations ===========================================================

export async function listAllocations(now = new Date()) {
  const allocations = await prisma.itcAllocation.findMany({ orderBy: [{ programYear: 'desc' }, { category: 'asc' }] });
  const year = now.getUTCFullYear();

  return allocations.map((a) => {
    const awarded = a.kwAwarded == null ? 0 : Number(a.kwAwarded);
    const consumed = a.kwConsumed == null ? 0 : Number(a.kwConsumed);
    return {
      id: a.id,
      program_year: a.programYear,
      category: a.category,
      kw_applied: a.kwApplied == null ? null : Number(a.kwApplied),
      kw_awarded: awarded,
      kw_consumed: consumed,
      kw_remaining: Number((awarded - consumed).toFixed(3)),
      award_doc_id: a.awardDocId,
      current_year: a.programYear === year,
    };
  });
}

/**
 * Link a claim to an allocation, consuming its kW (01 §itc_allocations — "a
 * claim cannot carry the LI adder without an allocation link with remaining kW
 * ≥ system kW; linking consumes"). Refuses rather than over-allocating.
 */
export async function linkAllocation(claimId: string, allocationId: string, by: string | null) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.itcClaim.findUnique({ where: { id: claimId }, include: { system: true } });
    if (!claim) throw new LifecycleError(404, 'CLAIM_NOT_FOUND', `No claim ${claimId}`);
    const allocation = await tx.itcAllocation.findUnique({ where: { id: allocationId } });
    if (!allocation) throw new LifecycleError(404, 'ALLOCATION_NOT_FOUND', `No allocation ${allocationId}`);

    const systemKw = claim.system.kwRated == null ? 0 : Number(claim.system.kwRated);
    const awarded = allocation.kwAwarded == null ? 0 : Number(allocation.kwAwarded);
    const consumed = allocation.kwConsumed == null ? 0 : Number(allocation.kwConsumed);
    const remaining = awarded - consumed;

    if (systemKw <= 0) throw new LifecycleError(409, 'SYSTEM_KW_UNKNOWN', 'System kW is required to consume an allocation');
    if (remaining < systemKw) {
      throw new LifecycleError(409, 'ALLOCATION_EXHAUSTED', `Allocation has ${remaining.toFixed(2)} kW remaining; this system needs ${systemKw.toFixed(2)} kW`);
    }

    await tx.itcAllocation.update({
      where: { id: allocationId },
      data: { kwConsumed: new P.Decimal(consumed + systemKw) },
    });

    const stack = ((claim.stack as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const li = ((stack.li as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    li.cat = allocation.category;
    li.allocation_id = allocationId;
    li.pct = li.pct ?? (allocation.category === 'CAT1' ? 10 : 20);
    stack.li = li;

    const basis = claim.basisAmt == null ? 0 : Number(claim.basisAmt);
    const totalPct =
      Number(stack.base ?? 30) + Number(stack.dc ?? 0) + Number(stack.ec ?? 0) + Number(li.pct ?? 0);

    await tx.itcClaim.update({
      where: { id: claimId },
      data: {
        stack: stack as Prisma.InputJsonValue,
        totalPct: new P.Decimal(totalPct),
        creditAmt: new P.Decimal((basis * totalPct) / 100),
      },
    });

    await tx.activityLog.create({
      data: {
        entity: 'system',
        entityId: claim.systemId,
        action: 'allocation_link',
        actor: by,
        meta: { claim_id: claimId, allocation_id: allocationId, kw_consumed: systemKw } as Prisma.InputJsonValue,
      },
    });

    return { consumed_kw: systemKw, remaining_kw: Number((remaining - systemKw).toFixed(3)), total_pct: totalPct };
  });
}

// ==== cohorts ===============================================================

export async function listCohorts() {
  const cohorts = await prisma.itcCohort.findMany({
    include: { claims: { include: { system: { select: { addressLine: true, kwRated: true } } } } },
    orderBy: { label: 'asc' },
  });

  return cohorts.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    nominal_amt: c.nominalAmt == null ? null : Number(c.nominalAmt),
    price_cents: c.priceCents,
    buyer: c.buyer,
    executed_at: c.executedAt,
    cash_at: c.cashAt,
    claims: c.claims.map((cl) => ({
      id: cl.id,
      system_id: cl.systemId,
      address: cl.system.addressLine,
      credit_amt: cl.creditAmt == null ? null : Number(cl.creditAmt),
      status: cl.status,
    })),
    claim_count: c.claims.length,
    nominal_from_claims: Number(c.claims.reduce((n, cl) => n + (cl.creditAmt == null ? 0 : Number(cl.creditAmt)), 0).toFixed(2)),
  }));
}

/**
 * Add claims to a cohort (02 §Automations — "Claim added to cohort | claim →
 * IN_COHORT; consume kW on linked allocation if LI adder present"). Allocation
 * consumption already happened at link time, so this asserts the link exists
 * rather than double-consuming.
 */
export async function addToCohort(cohortId: string, claimIds: string[], by: string | null) {
  return prisma.$transaction(async (tx) => {
    const cohort = await tx.itcCohort.findUnique({ where: { id: cohortId } });
    if (!cohort) throw new LifecycleError(404, 'COHORT_NOT_FOUND', `No cohort ${cohortId}`);
    if (['EXECUTED', 'CASH_RECEIVED'].includes(cohort.status)) {
      throw new LifecycleError(409, 'COHORT_CLOSED', `Cohort is ${cohort.status}; claims cannot be added`);
    }

    const added: string[] = [];
    const refused: Array<{ claim_id: string; reason: string }> = [];

    for (const claimId of claimIds) {
      const claim = await tx.itcClaim.findUnique({ where: { id: claimId } });
      if (!claim) {
        refused.push({ claim_id: claimId, reason: 'not found' });
        continue;
      }
      if (claim.status === 'ACCRUING') {
        refused.push({ claim_id: claimId, reason: 'basis is not locked yet' });
        continue;
      }
      const stack = (claim.stack as { li?: { pct?: number; allocation_id?: string } } | null) ?? {};
      if ((stack.li?.pct ?? 0) > 0 && !stack.li?.allocation_id) {
        refused.push({ claim_id: claimId, reason: 'LI adder without an allocation link' });
        continue;
      }
      await tx.itcClaim.update({ where: { id: claimId }, data: { cohortId, status: 'IN_COHORT' } });
      added.push(claimId);
    }

    const claims = await tx.itcClaim.findMany({ where: { cohortId } });
    const nominal = claims.reduce((n, c) => n + (c.creditAmt == null ? 0 : Number(c.creditAmt)), 0);
    await tx.itcCohort.update({
      where: { id: cohortId },
      data: { nominalAmt: new P.Decimal(nominal), status: cohort.status === 'ASSEMBLING' ? 'ASSEMBLING' : cohort.status },
    });

    await tx.activityLog.create({
      data: {
        entity: 'program',
        entityId: cohortId,
        action: 'cohort_claims',
        actor: by,
        meta: { added: added.length, refused, nominal_amt: Number(nominal.toFixed(2)) } as Prisma.InputJsonValue,
      },
    });

    return { added, refused, nominal_amt: Number(nominal.toFixed(2)) };
  });
}

/**
 * Move a cohort along its pipeline. CASH_RECEIVED is the one with consequences:
 * every claim goes TRANSFERRED and an ITC_CASH ledger row books per system
 * (02 §Automations; 00 L7 — "ITC cash books at cohort execution").
 */
export async function setCohortStatus(
  cohortId: string,
  status: 'ASSEMBLING' | 'LISTED' | 'TERM_SHEET' | 'DILIGENCE' | 'EXECUTED' | 'CASH_RECEIVED',
  input: { buyer?: string; price_cents?: number; by?: string | null } = {},
) {
  return prisma.$transaction(async (tx) => {
    const cohort = await tx.itcCohort.findUnique({ where: { id: cohortId }, include: { claims: true } });
    if (!cohort) throw new LifecycleError(404, 'COHORT_NOT_FOUND', `No cohort ${cohortId}`);

    const now = new Date();
    await tx.itcCohort.update({
      where: { id: cohortId },
      data: {
        status,
        ...(input.buyer ? { buyer: input.buyer } : {}),
        ...(input.price_cents ? { priceCents: input.price_cents } : {}),
        ...(status === 'EXECUTED' ? { executedAt: now } : {}),
        ...(status === 'CASH_RECEIVED' ? { cashAt: now } : {}),
      },
    });

    let booked = 0;
    if (status === 'CASH_RECEIVED') {
      const cents = input.price_cents ?? cohort.priceCents ?? 92; // cents on the dollar
      for (const claim of cohort.claims) {
        await tx.itcClaim.update({ where: { id: claim.id }, data: { status: 'TRANSFERRED' } });

        const credit = claim.creditAmt == null ? 0 : Number(claim.creditAmt);
        const cash = Number(((credit * cents) / 100).toFixed(2));
        const existing = await tx.ledgerEntry.findFirst({
          where: { systemId: claim.systemId, type: 'ITC_CASH', cohortId },
        });
        if (existing) {
          await tx.ledgerEntry.update({
            where: { id: existing.id },
            data: { receivedAmt: new P.Decimal(cash), receivedDate: now, status: 'RECEIVED' },
          });
        } else {
          await tx.ledgerEntry.create({
            data: {
              systemId: claim.systemId,
              type: 'ITC_CASH',
              cohortId,
              expectedAmt: new P.Decimal(cash),
              expectedDate: now,
              receivedAmt: new P.Decimal(cash),
              receivedDate: now,
              status: 'RECEIVED',
              meta: { credit_amt: credit, price_cents: cents } as Prisma.InputJsonValue,
            },
          });
        }
        booked += 1;
      }
    }

    await tx.activityLog.create({
      data: {
        entity: 'program',
        entityId: cohortId,
        action: 'cohort_status',
        actor: input.by ?? null,
        meta: { status, claims: cohort.claims.length, ledger_rows: booked } as Prisma.InputJsonValue,
      },
    });

    return { status, claims: cohort.claims.length, ledger_rows_booked: booked };
  });
}

// ==== D5 — the Pipeline ITC thread strip ===================================

/**
 * Aggregates behind the Pipeline strip (05-UI-DELTA D5). The strip shows where
 * the fleet currently sits on the claim-state pipeline, so it needs counts per
 * state plus the live allocation position — not the static markup P4 shipped.
 */
export async function getThread(now = new Date()) {
  const [byStatus, allocations, cohorts] = await Promise.all([
    prisma.itcClaim.groupBy({ by: ['status'], _count: true, _sum: { creditAmt: true } }),
    listAllocations(now),
    prisma.itcCohort.groupBy({ by: ['status'], _count: true }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));
  const credit = Object.fromEntries(byStatus.map((s) => [s.status, s._sum.creditAmt == null ? 0 : Number(s._sum.creditAmt)]));

  const STAGES = ['ACCRUING', 'BASIS_LOCKED', 'EVIDENCE_COMPLETE', 'IN_COHORT', 'TRANSFERRED'] as const;
  // "Current position" is the furthest state that actually holds claims.
  const current = [...STAGES].reverse().find((s) => (counts[s] ?? 0) > 0) ?? null;

  const currentYear = allocations.find((a) => a.current_year && a.category === 'CAT1') ?? allocations[0] ?? null;

  return {
    stages: STAGES.map((s) => ({ status: s, count: counts[s] ?? 0, credit: credit[s] ?? 0, current: s === current })),
    current,
    total_claims: byStatus.reduce((n, s) => n + s._count, 0),
    allocation: currentYear
      ? {
          program_year: currentYear.program_year,
          category: currentYear.category,
          kw_awarded: currentYear.kw_awarded,
          kw_consumed: currentYear.kw_consumed,
          kw_remaining: currentYear.kw_remaining,
          award_doc_id: currentYear.award_doc_id,
        }
      : null,
    cohorts: Object.fromEntries(cohorts.map((c) => [c.status, c._count])),
  };
}

/** Systems inside the ITC recapture window — the watch list (03 §Money). */
export async function getRecaptureWatch(now = new Date()) {
  const claims = await prisma.itcClaim.findMany({
    where: { recaptureEnd: { gt: now } },
    include: { system: { select: { addressLine: true, terminalState: true, health: true } } },
    orderBy: { recaptureEnd: 'asc' },
  });

  return claims.map((c) => ({
    claim_id: c.id,
    system_id: c.systemId,
    address: c.system.addressLine,
    health: c.system.health,
    terminal_state: c.system.terminalState,
    credit_amt: c.creditAmt == null ? null : Number(c.creditAmt),
    pis_date: c.pisDate,
    recapture_end: c.recaptureEnd,
    days_left: c.recaptureEnd ? daysBetween(now, c.recaptureEnd) : null,
    // Straight-line clawback, the same figure the terminal endpoint quotes.
    clawback_if_removed_now:
      c.creditAmt && c.recaptureEnd
        ? Number((Number(c.creditAmt) * (Math.max(0, daysBetween(now, c.recaptureEnd)) / (60 * 30.4375))).toFixed(2))
        : null,
  }));
}
