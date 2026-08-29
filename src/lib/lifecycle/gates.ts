/**
 * The one gate validator (02 §Gate predicates). Every caller — the Advance
 * button, the kanban drag, the document-date writes, and the poller — reaches
 * a stage's exit gate through `evaluateGate`. Zero stage logic lives anywhere else.
 *
 * The unmet list is returned in the verbatim 422 shape ({ key, label, owner_role }).
 * For AUTO transitions the gate predicate IS the trigger predicate, so the same
 * function both blocks a premature manual advance and green-lights the automation.
 */
import type { Prisma, Stage, System } from '@prisma/client';
import type { Unmet } from './errors';
import { shortCode } from './transitions';

export interface GateResult {
  gate: string;
  unmet: Unmet[];
}

type Tx = Prisma.TransactionClient;

// Required checklist items still OPEN block the gate. NA (conditional-false) and
// DONE both pass. autoOnly items (telemetry, DERMS) count too — the machine, not
// the crew, closes them, so a manual advance correctly sees them as unmet.
async function openRequiredItems(tx: Tx, system: System): Promise<Unmet[]> {
  const items = await tx.checklistItem.findMany({
    where: { systemId: system.id, stage: system.stage, required: true, state: 'OPEN' },
    orderBy: { key: 'asc' },
  });
  return items.map((i) => ({ key: i.key, label: i.label, owner_role: i.ownerRole ?? null }));
}

async function s06Gate(tx: Tx, system: System): Promise<Unmet[]> {
  const unmet = await openRequiredItems(tx, system);
  // Plus a real INSTALL work order with crew + date + check-in (02 §S06 gate).
  const wo = await tx.workOrder.findFirst({
    where: {
      systemId: system.id,
      type: 'INSTALL',
      crewId: { not: null },
      date: { not: null },
      checkinAt: { not: null },
    },
  });
  if (!wo) {
    unmet.push({ key: 'work_order_checkin', label: 'INSTALL work order checked in (crew on site)', owner_role: 'FIELD' });
  }
  return unmet;
}

/**
 * Evaluate the exit gate of the system's CURRENT stage. Empty `unmet` ⇒ may advance.
 */
export async function evaluateGate(tx: Tx, system: System): Promise<GateResult> {
  const gate = shortCode(system.stage);
  const unmet = await gateUnmet(tx, system);
  return { gate, unmet };
}

async function gateUnmet(tx: Tx, system: System): Promise<Unmet[]> {
  const stage: Stage = system.stage;
  switch (stage) {
    case 'S01_LEAD':
      return system.currentSnapshotId
        ? []
        : [{ key: 'qualification_snapshot', label: 'Qualification snapshot written', owner_role: 'OPS' }];

    case 'S04_APPLIED':
      // Gate is rof_date (the ROF letter feeds it); S04's other items don't gate S05.
      return system.rofDate
        ? []
        : [{ key: 'rof_letter', label: 'ROF letter logged (writes rof_date)', owner_role: 'OPS' }];

    case 'S06_SCHEDULED':
      return s06Gate(tx, system);

    case 'S08_COMMISSIONED':
      // Gate is cof_date (the four sub-items feed it; COF is the gate).
      return system.cofDate
        ? []
        : [{ key: 'cof_letter', label: 'COF letter logged (writes cof_date)', owner_role: 'OPS' }];

    case 'S09_LIVE':
      return []; // momentary — chains straight to OPERATING

    default:
      // S02, S03, S05, S07 — required checklist items DONE (NA excluded).
      return openRequiredItems(tx, system);
  }
}
