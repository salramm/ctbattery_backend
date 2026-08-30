/**
 * Property page — the batch surface (03 §Property page). A property is the
 * working surface; the unit (a `systems` row) stays the atom.
 *
 * Batch actions never contain stage logic: each one filters units by its own
 * precondition and then calls the lib/lifecycle public surface, reporting the
 * engine's own refusal as the per-unit reason. "23 submitted, 2 skipped:
 * missing T&C" is the shape the mock promises, so every unit it touched is
 * reported individually.
 */
import type { Stage, System } from '@prisma/client';
import prisma from '../config/database';
import { advance, applyChecklist, onSnapshotWritten, LifecycleError, STAGE_ORDER, stageLabel, shortCode } from '../lib/lifecycle';

// ==== read =================================================================

const LIVE_STAGES: Stage[] = ['S09_LIVE', 'OPERATING'];

function stageIdx(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

export async function getProperty(id: string) {
  const property = await prisma.property.findUnique({
    where: { id },
    include: {
      account: { include: { contacts: true } },
      masterAgmtDoc: true,
    },
  });
  if (!property) throw new LifecycleError(404, 'PROPERTY_NOT_FOUND', `No property ${id}`);

  const systems = await prisma.system.findMany({
    where: { propertyId: id },
    orderBy: [{ unitLabel: 'asc' }, { createdAt: 'asc' }],
    include: { resident: { select: { name: true } } },
  });

  // Which units have a signed ESA — the release meter's first number.
  const esaDone = await prisma.checklistItem.findMany({
    where: { systemId: { in: systems.map((s) => s.id) }, key: 'esa_signed', state: 'DONE' },
    select: { systemId: true },
  });
  const esaSet = new Set(esaDone.map((e) => e.systemId));

  const active = systems.filter((s) => !s.terminalState);
  const byStage: Record<string, number> = {};
  for (const s of active) byStage[s.stage] = (byStage[s.stage] ?? 0) + 1;

  const units = systems.map((s) => ({
    id: s.id,
    unit_label: s.unitLabel,
    address_line: s.addressLine,
    stage: s.stage,
    stage_code: shortCode(s.stage),
    stage_label: stageLabel(s.stage),
    blocked_code: s.blockedCode,
    terminal_state: s.terminalState,
    health: s.health,
    resident: s.resident?.name ?? null,
    flags: s.flags,
  }));

  return {
    property: {
      id: property.id,
      name: property.name,
      address: property.address,
      town: property.town,
      account: property.account
        ? { id: property.account.id, name: property.account.name, type: property.account.type, deal_state: property.account.dealState }
        : null,
      master_agreement: property.masterAgmtDoc
        ? { doc_id: property.masterAgmtDoc.id, status: property.masterAgmtDoc.status, signed_at: property.masterAgmtDoc.signedAt }
        : null,
      geo: property.geo,
    },
    release_meter: {
      units: systems.length,
      active: active.length,
      esas_signed: active.filter((s) => esaSet.has(s.id)).length,
      applied: active.filter((s) => stageIdx(s.stage) >= stageIdx('S04_APPLIED')).length,
      rof: active.filter((s) => s.rofDate != null).length,
      installed: active.filter((s) => stageIdx(s.stage) >= stageIdx('S07_INSTALLED')).length,
      live: active.filter((s) => LIVE_STAGES.includes(s.stage)).length,
      blocked: active.filter((s) => s.blockedCode != null).length,
      terminal: systems.length - active.length,
      by_stage: STAGE_ORDER.map((stage) => ({ stage, code: shortCode(stage), count: byStage[stage] ?? 0 })),
    },
    units,
    contacts: (property.account?.contacts ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      phone: c.phone,
      email: c.email,
    })),
  };
}

/** Property-scoped documents (Documents tab). */
export async function getPropertyDocuments(id: string) {
  const systemIds = (await prisma.system.findMany({ where: { propertyId: id }, select: { id: true } })).map((s) => s.id);
  const docs = await prisma.document.findMany({
    where: { OR: [{ propertyId: id }, { systemId: { in: systemIds } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return docs.map((d) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    status: d.status,
    envelope_id: d.envelopeId,
    signed_at: d.signedAt,
    system_id: d.systemId,
    created_at: d.createdAt,
  }));
}

/** Activity feed across the property's units (Activity tab). */
export async function getPropertyActivity(id: string, limit = 100) {
  const systemIds = (await prisma.system.findMany({ where: { propertyId: id }, select: { id: true } })).map((s) => s.id);
  if (systemIds.length === 0) return [];
  const rows = await prisma.activityLog.findMany({
    where: { entity: 'system', entityId: { in: systemIds } },
    orderBy: { at: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({ id: r.id, system_id: r.entityId, action: r.action, actor: r.actor, at: r.at, meta: r.meta }));
}

// ==== batch ================================================================

export type BatchAction =
  | 'qualify_all'
  | 'generate_esas'
  | 'submit_cgb_apps'
  | 'build_install_week'
  | 'submit_completion_pkgs';

/** Stages each action is willing to act on — its precondition filter. */
const ELIGIBLE: Record<BatchAction, Stage[]> = {
  qualify_all: ['S01_LEAD'],
  generate_esas: ['S02_QUALIFIED'],
  submit_cgb_apps: ['S03_COMMITTED', 'S04_APPLIED'],
  build_install_week: ['S06_SCHEDULED'],
  submit_completion_pkgs: ['S08_COMMISSIONED'],
};

export interface UnitResult {
  system_id: string;
  unit_label: string | null;
  address_line: string | null;
  result: 'applied' | 'skipped';
  detail: string;
}

/** Turn any engine refusal into the per-unit reason the UI prints. */
function refusal(err: unknown): string {
  if (err instanceof LifecycleError) {
    if (err.code === 'GATE_UNMET') {
      const unmet = (err.payload?.unmet as Array<{ label: string }> | undefined) ?? [];
      return unmet.length ? `unmet: ${unmet.map((u) => u.label).join(' · ')}` : err.message;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'failed';
}

async function actOn(system: System, action: BatchAction, by: string | null): Promise<UnitResult> {
  const base = { system_id: system.id, unit_label: system.unitLabel, address_line: system.addressLine };
  try {
    switch (action) {
      case 'qualify_all': {
        if (!system.currentSnapshotId) {
          return { ...base, result: 'skipped', detail: 'no qualification snapshot yet — run intake' };
        }
        await onSnapshotWritten(system.id, { edcServed: true, by });
        return { ...base, result: 'applied', detail: 'qualified → S02' };
      }

      case 'generate_esas': {
        // S02 → S03 instantiates the S03 checklist and sends the envelope set.
        await advance(system.id, { via: 'MANUAL', by });
        return { ...base, result: 'applied', detail: 'committed → S03 · ESA/T&C/payee envelopes queued' };
      }

      case 'submit_cgb_apps': {
        // S03 units must clear their signature gate into S04 first.
        if (system.stage === 'S03_COMMITTED') await advance(system.id, { via: 'MANUAL', by });
        await applyChecklist(system.id, { key: 'cgb_app_submitted', state: 'DONE', by });
        return { ...base, result: 'applied', detail: 'CGB application submitted' };
      }

      case 'build_install_week': {
        const existing = await prisma.workOrder.findFirst({
          where: { systemId: system.id, type: 'INSTALL', status: { not: 'CANCELLED' } },
        });
        if (existing?.crewId && existing.date) {
          return { ...base, result: 'skipped', detail: 'install work order already scheduled' };
        }
        const crew = await prisma.crew.findFirst({ orderBy: { label: 'asc' } });
        if (!crew) return { ...base, result: 'skipped', detail: 'no crew on file to assign' };

        // Next Monday, so a batch lands as one install week.
        const date = nextMonday();
        if (existing) {
          await prisma.workOrder.update({ where: { id: existing.id }, data: { crewId: crew.id, date, status: 'SCHEDULED' } });
        } else {
          await prisma.workOrder.create({
            data: { systemId: system.id, type: 'INSTALL', crewId: crew.id, date, status: 'SCHEDULED' },
          });
        }
        await applyChecklist(system.id, { key: 'crew_assigned', state: 'DONE', by });
        return { ...base, result: 'applied', detail: `crew ${crew.label} · ${date.toISOString().slice(0, 10)}` };
      }

      case 'submit_completion_pkgs': {
        await applyChecklist(system.id, { key: 'cgb_pkg_accepted', state: 'DONE', by });
        return { ...base, result: 'applied', detail: 'completion package submitted' };
      }
    }
  } catch (err) {
    return { ...base, result: 'skipped', detail: refusal(err) };
  }
}

function nextMonday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d;
}

/**
 * Run a batch action across the property's units. Only units meeting the
 * action's precondition are touched; each reports its own outcome.
 */
export async function runBatch(
  propertyId: string,
  action: BatchAction,
  unitIds: string[] | undefined,
  by: string | null,
) {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true } });
  if (!property) throw new LifecycleError(404, 'PROPERTY_NOT_FOUND', `No property ${propertyId}`);

  const candidates = await prisma.system.findMany({
    where: {
      propertyId,
      terminalState: null,
      stage: { in: ELIGIBLE[action] },
      ...(unitIds?.length ? { id: { in: unitIds } } : {}),
    },
    orderBy: [{ unitLabel: 'asc' }],
  });

  const results: UnitResult[] = [];
  for (const system of candidates) {
    // Blocked units never advance — report rather than throw (02 §Blocked).
    if (system.blockedCode) {
      results.push({
        system_id: system.id,
        unit_label: system.unitLabel,
        address_line: system.addressLine,
        result: 'skipped',
        detail: `${system.blockedCode} must clear first`,
      });
      continue;
    }
    results.push(await actOn(system, action, by));
  }

  const applied = results.filter((r) => r.result === 'applied').length;
  await prisma.activityLog.create({
    data: {
      entity: 'property',
      entityId: propertyId,
      action: `batch:${action}`,
      actor: by,
      meta: { action, eligible: candidates.length, applied, skipped: results.length - applied },
    },
  });

  return {
    action,
    ran_at: new Date(),
    eligible: candidates.length,
    applied,
    skipped: results.length - applied,
    results,
  };
}

/** Counts behind each batch button's "acts on N at S0x" caption. */
export async function getBatchCounts(propertyId: string) {
  const systems = await prisma.system.findMany({
    where: { propertyId, terminalState: null },
    select: { stage: true },
  });
  const counts = {} as Record<BatchAction, number>;
  for (const action of Object.keys(ELIGIBLE) as BatchAction[]) {
    counts[action] = systems.filter((s) => ELIGIBLE[action].includes(s.stage)).length;
  }
  return counts;
}
