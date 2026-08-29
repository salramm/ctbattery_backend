/**
 * GET /api/lifecycle/map payload (05-UI-DELTA D3). Assembles the overlay content
 * entirely from the seed tables (checklist_templates + blocked_codes + clocks)
 * plus the TRANSITIONS constant — the seeds are the single source of truth, so
 * the overlay is a live projection of them, never hardcoded (§4 shim #4).
 */
import type { Stage } from '@prisma/client';
import prisma from '../../config/database';
import { STAGE_ORDER, TRANSITIONS, nextTransition, shortCode, stageLabel } from './transitions';

// Meaning lines per stage (03/mockup final copy is applied in the P11 overlay;
// these one-liners describe the gate the stage must clear to advance).
const STAGE_MEANING: Record<Stage, string> = {
  S01_LEAD: 'A unit exists; qualification runs and writes the snapshot.',
  S02_QUALIFIED: 'Qualified in an EDC territory; confirm contact and the name match.',
  S03_COMMITTED: 'Agreements signed (ESA, T&C, payee; master agreement if MFAH).',
  S04_APPLIED: 'IX + CGB applications filed; ROF letter closes the stage.',
  S05_ENTITLED: 'Reservation locked; permit, IX, equipment, and connection method line up.',
  S06_SCHEDULED: 'Crew, resident, and (if needed) meter pull scheduled; crew checks in.',
  S07_INSTALLED: 'Field checklist complete; the machine confirms telemetry.',
  S08_COMMISSIONED: 'Self-inspection, PTO, DERMS, CGB package; COF letter closes the stage.',
  S09_LIVE: 'Live — chained straight to Operating in the same transaction.',
  OPERATING: 'Earning: basis locked, enrollment booked, health polled.',
};

export async function buildLifecycleMap() {
  const [templates, codes, clocks] = await Promise.all([
    prisma.checklistTemplate.findMany({ orderBy: [{ stage: 'asc' }, { sort: 'asc' }] }),
    prisma.blockedCode.findMany({ orderBy: { code: 'asc' } }),
    prisma.clock.findMany(),
  ]);

  const byStageTemplates = new Map<Stage, typeof templates>();
  for (const t of templates) {
    const arr = byStageTemplates.get(t.stage) ?? [];
    arr.push(t);
    byStageTemplates.set(t.stage, arr);
  }
  const byStageCodes = new Map<Stage, typeof codes>();
  for (const c of codes) {
    const arr = byStageCodes.get(c.stage) ?? [];
    arr.push(c);
    byStageCodes.set(c.stage, arr);
  }

  const stages = STAGE_ORDER.map((stage) => {
    const t = nextTransition(stage);
    return {
      stage,
      code: shortCode(stage),
      label: stageLabel(stage),
      meaning: STAGE_MEANING[stage],
      gate: (byStageTemplates.get(stage) ?? [])
        .sort((a, b) => a.sort - b.sort)
        .map((tp) => ({
          key: tp.key,
          label: tp.label,
          required: tp.required,
          conditional: tp.conditional,
          auto_only: tp.autoOnly,
          owner_role: tp.ownerRole,
        })),
      block_codes: (byStageCodes.get(stage) ?? []).map((c) => ({
        code: c.code,
        label: c.label,
        today_after_days: c.todayAfterDays,
      })),
      transition: t ? { to: t.to, driver: t.driver, fires: t.fires } : null,
    };
  });

  return {
    stages,
    transitions: TRANSITIONS,
    clocks: clocks.map((c) => ({
      key: c.key,
      starts_on: c.startsOn,
      length_months: c.lengthMonths,
      length_days: c.lengthDays,
      warn_at: c.warnAt,
      consequence: c.consequence,
    })),
  };
}
