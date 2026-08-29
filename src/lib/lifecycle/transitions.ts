/**
 * The locked transition map (02 §Transitions, L4). Single source of truth for
 * stage ordering and the driver (AUTO vs MANUAL) of every step. No caller may
 * add a transition beyond this list; the gate/advance engine reads only from here.
 *
 * Invariant that makes the auto-runner correct: for every AUTO transition the
 * exit gate of the `from` stage IS the trigger predicate (02 explicitly states
 * this for S05, and it holds for all AUTO rows). So "advance while the next
 * transition is AUTO and its gate passes" reproduces every automation exactly.
 */
import type { Stage } from '@prisma/client';

export type Driver = 'AUTO' | 'MANUAL';

export interface Transition {
  from: Stage;
  to: Stage;
  driver: Driver;
  /** Human description of when it fires — rendered on the lifecycle-map connectors. */
  fires: string;
}

/** Linear stage order (01 §Enums). Index is the ordinal used to reject skips/backward. */
export const STAGE_ORDER: Stage[] = [
  'S01_LEAD',
  'S02_QUALIFIED',
  'S03_COMMITTED',
  'S04_APPLIED',
  'S05_ENTITLED',
  'S06_SCHEDULED',
  'S07_INSTALLED',
  'S08_COMMISSIONED',
  'S09_LIVE',
  'OPERATING',
];

export const TRANSITIONS: Transition[] = [
  { from: 'S01_LEAD', to: 'S02_QUALIFIED', driver: 'AUTO', fires: 'qualification snapshot written (current_snapshot_id set); non-EDC → DISQUALIFIED' },
  { from: 'S02_QUALIFIED', to: 'S03_COMMITTED', driver: 'MANUAL', fires: 'ops/sales confirms commitment path' },
  { from: 'S03_COMMITTED', to: 'S04_APPLIED', driver: 'MANUAL', fires: 'all S03 signature items DONE' },
  { from: 'S04_APPLIED', to: 'S05_ENTITLED', driver: 'AUTO', fires: 'rof_date written (ROF letter logged)' },
  { from: 'S05_ENTITLED', to: 'S06_SCHEDULED', driver: 'AUTO', fires: 'all required S05 items DONE' },
  { from: 'S06_SCHEDULED', to: 'S07_INSTALLED', driver: 'AUTO', fires: 'INSTALL work order checkin_at written (crew on site)' },
  { from: 'S07_INSTALLED', to: 'S08_COMMISSIONED', driver: 'AUTO', fires: 'field checklist 100% ∧ telemetry_confirmed' },
  { from: 'S08_COMMISSIONED', to: 'S09_LIVE', driver: 'AUTO', fires: 'cof_date written (COF letter logged)' },
  { from: 'S09_LIVE', to: 'OPERATING', driver: 'AUTO', fires: 'chained in the same transaction as S08→S09' },
];

/** Short gate code shown to clients: S05_ENTITLED → "S05", OPERATING → "OP". */
export function shortCode(stage: Stage): string {
  if (stage === 'OPERATING') return 'OP';
  return stage.slice(0, 3);
}

/** Human label: S05_ENTITLED → "ENTITLED". */
export function stageLabel(stage: Stage): string {
  return stage === 'OPERATING' ? 'OPERATING' : stage.slice(4);
}

export function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** The single forward transition out of a stage, or null at OPERATING (terminal-of-progress). */
export function nextTransition(stage: Stage): Transition | null {
  return TRANSITIONS.find((t) => t.from === stage) ?? null;
}
