/**
 * GET /api/lifecycle/map payload (05-UI-DELTA D3). Assembles the overlay content
 * entirely from the seed tables (checklist_templates + blocked_codes + clocks)
 * plus the TRANSITIONS constant — the seeds are the single source of truth, so
 * the overlay is a live projection of them, never hardcoded (§4 shim #4).
 */
import type { Stage } from '@prisma/client';
import prisma from '../../config/database';
import { STAGE_ORDER, TRANSITIONS, nextTransition, shortCode, stageLabel } from './transitions';

/**
 * Era bands (05-UI-DELTA D3 — "era band → accordion"). This is layout copy from
 * the mock, not stage content: which items, codes and clocks a stage carries
 * still comes entirely from the seed tables below.
 */
const ERAS = [
  { key: 'ACQUIRE', label: 'ACQUIRE · S01–S03', note: 'people work', stages: ['S01_LEAD', 'S02_QUALIFIED', 'S03_COMMITTED'], color: '#8A9B7E', flex: 3 },
  { key: 'ENTITLE', label: 'ENTITLE · S04–S05', note: 'paper work', stages: ['S04_APPLIED', 'S05_ENTITLED'], color: '#6C9E74', flex: 2 },
  { key: 'BUILD', label: 'BUILD · S06–S08', note: 'hands work', stages: ['S06_SCHEDULED', 'S07_INSTALLED', 'S08_COMMISSIONED'], color: '#549066', flex: 3 },
  { key: 'OPERATE', label: 'OPERATE · S09 →', note: 'software works', stages: ['S09_LIVE', 'OPERATING'], color: '#2C5140', flex: 2 },
];

/**
 * Which stage each clock is worth showing against. The `clocks` seed has no
 * stage column — a clock is keyed to a date field, not a stage — so this is a
 * presentational association only. The clock rows themselves (length, warn,
 * consequence) are read from the seed and never restated here.
 */
const CLOCK_STAGE: Record<string, string> = {
  esa_cancellation: 'S03_COMMITTED',
  cgb_deficiency: 'S04_APPLIED',
  rof_build: 'S05_ENTITLED',
  workmanship: 'S07_INSTALLED',
  performance_term: 'OPERATING',
  itc_recapture: 'OPERATING',
  turnover_sla: 'OPERATING',
  li_allocation_window: 'S05_ENTITLED',
};

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
      era: ERAS.find((e) => e.stages.includes(stage))?.key ?? null,
      clocks: clocks
        .filter((c) => CLOCK_STAGE[c.key] === stage)
        .map((c) => ({
          key: c.key,
          starts_on: c.startsOn,
          length_months: c.lengthMonths,
          length_days: c.lengthDays,
          warn_at: c.warnAt,
          consequence: c.consequence,
        })),
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
    eras: ERAS,
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
