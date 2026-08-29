/**
 * On-enter side effects (02 §On-enter side effects). Each runs inside the same
 * transaction as the advance that triggered it. Data effects (checklist
 * instantiation, rate lock, ITC claim lifecycle, ledger rows, key dates) are
 * real; external effects (SMS, DocuSign, PDF, poller arms) go through the
 * notifications seam and are log-only for now.
 */
import type { Prisma, Stage, System } from '@prisma/client';
import { Prisma as P } from '@prisma/client';
import { notify } from './notifications';
import { evalConditional } from './conditionals';

type Tx = Prisma.TransactionClient;

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

/**
 * Instantiate the entered stage's checklist from `checklist_templates`,
 * evaluating each conditional at entry (false → NA). Idempotent: the
 * (system, stage, key) unique lets a re-entry skip duplicates.
 */
export async function instantiateChecklist(tx: Tx, system: System, stage: Stage): Promise<void> {
  const templates = await tx.checklistTemplate.findMany({ where: { stage }, orderBy: { sort: 'asc' } });
  if (templates.length === 0) return;

  const property = await tx.property.findUnique({ where: { id: system.propertyId } });
  const rows: Prisma.ChecklistItemCreateManyInput[] = templates.map((t) => ({
    systemId: system.id,
    stage: t.stage,
    key: t.key,
    label: t.label,
    required: t.required,
    ownerRole: t.ownerRole,
    // conditional-false → NA (excluded from the gate); everything else starts OPEN.
    state: evalConditional(t.conditional, { system, property }) ? 'OPEN' : 'NA',
  }));
  await tx.checklistItem.createMany({ data: rows, skipDuplicates: true });
}

async function lockRates(tx: Tx, system: System): Promise<Prisma.SystemUpdateInput> {
  const rofDate = system.rofDate ?? new Date();
  const programYear = rofDate.getUTCFullYear();
  const tier = system.tier ?? 'STANDARD';
  const rate = await tx.rateTable.findUnique({ where: { programYear_tier: { programYear, tier } } });

  const enrollRate = system.gridEdge ? rate?.enrollRateGridEdge ?? null : rate?.enrollRateOther ?? null;
  const lockedRates = {
    annual_rate: rate?.annualRateKwYr ? Number(rate.annualRateKwYr) : null,
    enroll_rate: enrollRate ? Number(enrollRate) : null,
    grid_edge: Boolean(system.gridEdge),
    locked_at: new Date().toISOString(),
  };

  return {
    tier,
    lockedRates: lockedRates as Prisma.InputJsonValue,
    rofDeadline: addMonths(rofDate, 24),
  };
}

async function openItcClaim(tx: Tx, system: System): Promise<void> {
  const existing = await tx.itcClaim.findUnique({ where: { systemId: system.id } });
  if (existing) return; // idempotent

  const snap = system.currentSnapshotId
    ? await tx.qualSnapshot.findUnique({ where: { id: system.currentSnapshotId } })
    : null;
  const profile = (snap?.itcProfile as { base?: number; dc?: number; ec?: number; li?: unknown } | null) ?? null;
  const stack = {
    base: profile?.base ?? 30,
    dc: profile?.dc ?? 0,
    ec: profile?.ec ?? 0,
    li: profile?.li ?? null,
  };
  await tx.itcClaim.create({
    data: {
      systemId: system.id,
      status: 'ACCRUING',
      stack: stack as Prisma.InputJsonValue,
    },
  });
}

/** OPERATING: place-in-service. Lock the ITC basis, book the enrollment incentive. */
async function operatingMoney(tx: Tx, system: System): Promise<Prisma.SystemUpdateInput> {
  const cof = system.cofDate ?? new Date();
  const pis = cof; // COF places the system in service
  const recaptureEnd = addMonths(pis, 60);
  const termEnd = addMonths(cof, 120);

  // --- ITC claim → BASIS_LOCKED --------------------------------------------
  const claim = await tx.itcClaim.findUnique({ where: { systemId: system.id }, include: { basisLines: true } });
  if (claim && claim.status === 'ACCRUING') {
    const stack = (claim.stack as { base?: number; dc?: number; ec?: number; li?: { pct?: number } } | null) ?? {};
    const liPct = stack.li?.pct ?? 0;
    const totalPct = (stack.base ?? 30) + (stack.dc ?? 0) + (stack.ec ?? 0) + liPct;

    // Basis sourced to documents (PO/WO/PERMIT). Minimal: one WO-sourced line from
    // the allocated equipment's PO unit costs, falling back to a nominal per-kWh cost.
    const basisAmt = await computeBasis(tx, system);
    if (claim.basisLines.length === 0) {
      await tx.itcBasisLine.create({ data: { claimId: claim.id, source: 'WO', amount: new P.Decimal(basisAmt) } });
    }
    const creditAmt = (basisAmt * totalPct) / 100;
    await tx.itcClaim.update({
      where: { id: claim.id },
      data: {
        status: 'BASIS_LOCKED',
        basisAmt: new P.Decimal(basisAmt),
        totalPct: new P.Decimal(totalPct),
        creditAmt: new P.Decimal(creditAmt),
        pisDate: pis,
        recaptureEnd,
      },
    });
  }

  // --- ENROLL_INC ledger row at the locked enroll rate × kWh ----------------
  const lockedRates = (system.lockedRates as { enroll_rate?: number | null } | null) ?? null;
  const enrollRate = lockedRates?.enroll_rate ?? 0;
  const kwh = system.kwhRated ? Number(system.kwhRated) : 0;
  const existingEnroll = await tx.ledgerEntry.findFirst({ where: { systemId: system.id, type: 'ENROLL_INC' } });
  if (!existingEnroll) {
    await tx.ledgerEntry.create({
      data: {
        systemId: system.id,
        type: 'ENROLL_INC',
        status: 'EXPECTED',
        expectedAmt: new P.Decimal(enrollRate * kwh),
        expectedDate: cof,
        meta: { enroll_rate: enrollRate, kwh } as Prisma.InputJsonValue,
      },
    });
  }

  notify.pollerArm(system.id, 'health');
  notify.sms(system.id, 'resident_welcome');

  return { pisDate: pis, recaptureEnd, termEnd };
}

/** Best-effort ITC basis: sum installed equipment PO unit costs, else nominal $/kWh. */
async function computeBasis(tx: Tx, system: System): Promise<number> {
  const equipment = await tx.equipment.findMany({
    where: { systemId: system.id },
    include: { po: true },
  });
  let fromPo = 0;
  for (const e of equipment) {
    const lines = (e.po?.lines as Array<{ sku?: string; unit_cost?: number }> | null) ?? [];
    const match = lines.find((l) => l.sku === e.sku);
    if (match?.unit_cost) fromPo += match.unit_cost;
  }
  if (fromPo > 0) return fromPo;
  const kwh = system.kwhRated ? Number(system.kwhRated) : 0;
  return kwh > 0 ? kwh * 400 : 12000; // nominal installed cost fallback
}

/**
 * Dispatch the on-enter effects for the stage just entered. `system` reflects
 * the post-advance row (stage already mutated). Returns extra column writes for
 * the caller to apply in the same update, keeping it to one row write.
 */
export async function onEnter(tx: Tx, system: System, stage: Stage): Promise<Prisma.SystemUpdateInput> {
  switch (stage) {
    case 'S02_QUALIFIED':
      await instantiateChecklist(tx, system, stage);
      return {};

    case 'S03_COMMITTED':
      await instantiateChecklist(tx, system, stage);
      notify.docusignSend(system.id, ['ESA', 'TC', 'PAYEE_DESIGNATION']);
      return {};

    case 'S04_APPLIED':
      await instantiateChecklist(tx, system, stage);
      notify.clockWatch(system.id, 'esa_cancellation');
      notify.reminder(system.id, 'resident_day2');
      return {};

    case 'S05_ENTITLED': {
      const rateWrites = await lockRates(tx, system);
      await instantiateChecklist(tx, system, stage);
      await openItcClaim(tx, system);
      notify.pollerArm(system.id, 'tracks:permit+ix+equipment');
      return rateWrites;
    }

    case 'S06_SCHEDULED':
      await instantiateChecklist(tx, system, stage);
      notify.batchSuggest(system.id);
      notify.sms(system.id, 'resident_confirm');
      return {};

    case 'S07_INSTALLED':
      await instantiateChecklist(tx, system, stage);
      notify.pollerArm(system.id, 'enlighten:telemetry');
      return {};

    case 'S08_COMMISSIONED': {
      await instantiateChecklist(tx, system, stage);
      // Self-inspection report is auto-compiled + submitted regardless of AHJ opt-in.
      notify.selfInspectionPdf(system.id);
      await tx.checklistItem.updateMany({
        where: { systemId: system.id, stage: 'S08_COMMISSIONED', key: 'self_inspection_submitted', state: 'OPEN' },
        data: { state: 'DONE', doneAt: new Date(), doneBy: 'system' },
      });
      notify.pollerArm(system.id, 'energyhub:x4+pto');
      return {};
    }

    case 'S09_LIVE':
      return {}; // momentary; chains to OPERATING

    case 'OPERATING':
      return operatingMoney(tx, system);

    default:
      return {};
  }
}
