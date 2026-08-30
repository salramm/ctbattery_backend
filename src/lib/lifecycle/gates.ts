/**
 * The one gate validator (02 §Gate predicates). Every caller — the Advance
 * button, the kanban drag, the document-date writes, and the poller — reaches
 * a stage's exit gate through `evaluateGate`. Zero stage logic lives anywhere else.
 *
 * The unmet list is returned in the verbatim 422 shape ({ key, label, owner_role }).
 * For AUTO transitions the gate predicate IS the trigger predicate, so the same
 * function both blocks a premature manual advance and green-lights the automation.
 *
 * There is exactly ONE predicate switch (`gateUnmet`). It reads its facts through
 * a `GateContext` so the same switch serves both the single-system path (queries
 * per call, inside the advance transaction) and the board path (facts preloaded
 * for many systems in two queries). Adding a batch reader must never mean
 * restating a predicate.
 */
import type { Prisma, Stage, System } from '@prisma/client';
import prisma from '../../config/database';
import type { Unmet } from './errors';
import { shortCode } from './transitions';

export interface GateResult {
  gate: string;
  unmet: Unmet[];
}

type Tx = Prisma.TransactionClient;

/** The facts the predicates need, however they were loaded. */
export interface GateContext {
  /** Required checklist items still OPEN at the system's current stage. */
  openRequired(system: System): Promise<Unmet[]>;
  /** An INSTALL work order with crew + date + check-in exists. */
  installWoCheckedIn(system: System): Promise<boolean>;
}

const WO_UNMET: Unmet = {
  key: 'work_order_checkin',
  label: 'INSTALL work order checked in (crew on site)',
  owner_role: 'FIELD',
};

function toUnmet(i: { key: string; label: string; ownerRole: string | null }): Unmet {
  return { key: i.key, label: i.label, owner_role: i.ownerRole ?? null };
}

/** Single-system context: reads straight through the (transaction) client. */
function liveContext(tx: Tx): GateContext {
  return {
    async openRequired(system) {
      // NA (conditional-false) and DONE both pass; auto-only items (telemetry,
      // DERMS) count too — the machine closes them, so a manual advance
      // correctly sees them as unmet.
      const items = await tx.checklistItem.findMany({
        where: { systemId: system.id, stage: system.stage, required: true, state: 'OPEN' },
        orderBy: { key: 'asc' },
      });
      return items.map(toUnmet);
    },
    async installWoCheckedIn(system) {
      const wo = await tx.workOrder.findFirst({
        where: {
          systemId: system.id,
          type: 'INSTALL',
          crewId: { not: null },
          date: { not: null },
          checkinAt: { not: null },
        },
      });
      return Boolean(wo);
    },
  };
}

/**
 * Board context: preload the same facts for many systems in two queries, then
 * answer from memory. Used by the pipeline board so rendering N cards is not N
 * round-trips per predicate.
 */
export async function batchContext(systems: System[]): Promise<GateContext> {
  const ids = systems.map((s) => s.id);
  if (ids.length === 0) return liveContext(prisma);

  const [items, wos] = await Promise.all([
    prisma.checklistItem.findMany({
      where: { systemId: { in: ids }, required: true, state: 'OPEN' },
      orderBy: { key: 'asc' },
    }),
    prisma.workOrder.findMany({
      where: {
        systemId: { in: ids },
        type: 'INSTALL',
        crewId: { not: null },
        date: { not: null },
        checkinAt: { not: null },
      },
      select: { systemId: true },
    }),
  ]);

  // Key by system + stage so an item from an earlier stage never counts.
  const byKey = new Map<string, Unmet[]>();
  for (const i of items) {
    const k = `${i.systemId}:${i.stage}`;
    const arr = byKey.get(k) ?? [];
    arr.push(toUnmet(i));
    byKey.set(k, arr);
  }
  const checkedIn = new Set(wos.map((w) => w.systemId));

  return {
    async openRequired(system) {
      return byKey.get(`${system.id}:${system.stage}`) ?? [];
    },
    async installWoCheckedIn(system) {
      return checkedIn.has(system.id);
    },
  };
}

/** Evaluate the exit gate of the system's CURRENT stage. Empty `unmet` ⇒ may advance. */
export async function evaluateGate(tx: Tx, system: System): Promise<GateResult> {
  return evaluateGateWith(liveContext(tx), system);
}

/** Same validator, against a preloaded context (board path). */
export async function evaluateGateWith(ctx: GateContext, system: System): Promise<GateResult> {
  return { gate: shortCode(system.stage), unmet: await gateUnmet(ctx, system) };
}

async function gateUnmet(ctx: GateContext, system: System): Promise<Unmet[]> {
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

    case 'S06_SCHEDULED': {
      // Required items PLUS a real INSTALL work order with crew + date + check-in.
      // Copy rather than push — the batch context hands back a cached array.
      const unmet = await ctx.openRequired(system);
      return (await ctx.installWoCheckedIn(system)) ? unmet : [...unmet, WO_UNMET];
    }

    case 'S08_COMMISSIONED':
      // Gate is cof_date (the four sub-items feed it; COF is the gate).
      return system.cofDate
        ? []
        : [{ key: 'cof_letter', label: 'COF letter logged (writes cof_date)', owner_role: 'OPS' }];

    case 'S09_LIVE':
      return []; // momentary — chains straight to OPERATING

    default:
      // S02, S03, S05, S07 — required checklist items DONE (NA excluded).
      return ctx.openRequired(system);
  }
}
