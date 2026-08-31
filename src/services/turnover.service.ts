/**
 * Turnover cases (02 §Automations — move-out rows; 03 §Property).
 *
 * A move-out is never a stage change (00). The battery keeps operating and
 * earning throughout; what changes is the paperwork. So a turnover is a case
 * with four fixed task slots, a 30-day SLA, and a `TURNOVER` flag that rides
 * alongside health until all four artifacts are on file.
 *
 * Residents are history, not a field: a move-out closes the current occupancy
 * with an `until` date and opens a new row. Nothing is ever overwritten
 * (01 §residents — "one row per occupancy; never overwrite").
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, openTurnover, daysBetween } from '../lib/lifecycle';

/** The four artifacts that close a case (01 §turnover_cases). */
export const TURNOVER_TASKS = ['new_esa', 'appendix_e', 'edc_update', 'derms_verify'] as const;
export type TurnoverTask = (typeof TURNOVER_TASKS)[number];

type Tasks = Record<string, string | boolean | null>;

/** All four slots filled — a doc id for the paperwork, true for the checks. */
export function allArtifactsOnFile(tasks: unknown): boolean {
  const t = (tasks as Tasks | null) ?? {};
  return TURNOVER_TASKS.every((k) => {
    const v = t[k];
    return v != null && v !== false && v !== '';
  });
}

export interface MoveOutInput {
  reason?: string;
  /** The incoming resident, when known at report time. */
  newResident?: { name?: string; edc_account_name?: string; phone?: string; email?: string };
  by?: string | null;
}

/**
 * Report a move-out — the Property page's [Report move-out], and the same path
 * the reconciliation name-mismatch takes.
 *
 * Idempotent: a system with an open case gets that case back rather than a
 * second one, because two open turnovers on one unit is not a real state.
 */
export async function reportMoveOut(systemId: string, input: MoveOutInput = {}) {
  const system = await prisma.system.findUnique({ where: { id: systemId }, include: { resident: true } });
  if (!system) throw new LifecycleError(404, 'SYSTEM_NOT_FOUND', `No system ${systemId}`);

  const existing = await prisma.turnoverCase.findFirst({ where: { systemId, closedAt: null } });
  if (existing) return { turnover: existing, system, already: true };

  const now = new Date();

  // Close the outgoing occupancy — history, never overwritten.
  if (system.residentId) {
    await prisma.resident.update({ where: { id: system.residentId }, data: { until: now } });
  }

  // Open the incoming occupancy when we already know who it is.
  let newResidentId: string | null = null;
  if (input.newResident?.name || input.newResident?.edc_account_name) {
    const resident = await prisma.resident.create({
      data: {
        systemId,
        name: input.newResident.name ?? null,
        edcAccountName: input.newResident.edc_account_name ?? null,
        phone: input.newResident.phone ?? null,
        email: input.newResident.email ?? null,
        since: now,
      },
    });
    newResidentId = resident.id;
    await prisma.system.update({ where: { id: systemId }, data: { residentId: resident.id } });
  } else {
    // Unit is vacant until the PM names the incoming resident.
    await prisma.system.update({ where: { id: systemId }, data: { residentId: null } });
  }

  // The case itself, its 30-day SLA and the TURNOVER flag (P2's primitive).
  const opened = await openTurnover(systemId, input.by ?? null);

  await prisma.activityLog.create({
    data: {
      entity: 'system',
      entityId: systemId,
      action: 'move_out',
      actor: input.by ?? null,
      meta: {
        turnover_id: opened.turnover.id,
        reason: input.reason ?? null,
        outgoing_resident_id: system.residentId,
        incoming_resident_id: newResidentId,
      } as Prisma.InputJsonValue,
    },
  });

  return { turnover: opened.turnover, system: opened.system, already: false };
}

/**
 * Fill one of the four task slots. When the last one lands the case closes
 * itself and the flag clears (02 §Automations — "All four turnover artifacts
 * on file | close case; clear flag").
 */
export async function setTurnoverTask(
  turnoverId: string,
  key: string,
  value: string | boolean,
  by: string | null,
) {
  if (!TURNOVER_TASKS.includes(key as TurnoverTask)) {
    throw new LifecycleError(400, 'UNKNOWN_TURNOVER_TASK', `${key} is not one of the four turnover artifacts`);
  }

  return prisma.$transaction(async (tx) => {
    const turnover = await tx.turnoverCase.findUnique({ where: { id: turnoverId } });
    if (!turnover) throw new LifecycleError(404, 'TURNOVER_NOT_FOUND', `No turnover case ${turnoverId}`);
    if (turnover.closedAt) throw new LifecycleError(409, 'TURNOVER_CLOSED', 'This case is already closed');

    const tasks = { ...(((turnover.tasks as Tasks) ?? {}) as Tasks), [key]: value };
    const complete = allArtifactsOnFile(tasks);

    const updated = await tx.turnoverCase.update({
      where: { id: turnoverId },
      data: { tasks: tasks as Prisma.InputJsonValue, ...(complete ? { closedAt: new Date() } : {}) },
    });

    let flagCleared = false;
    if (complete) {
      // Clear the flag only when no OTHER case is still open on this system.
      const stillOpen = await tx.turnoverCase.count({ where: { systemId: turnover.systemId, closedAt: null } });
      if (stillOpen === 0) {
        const system = await tx.system.findUniqueOrThrow({ where: { id: turnover.systemId } });
        await tx.system.update({
          where: { id: turnover.systemId },
          data: { flags: system.flags.filter((f) => f !== 'TURNOVER') },
        });
        flagCleared = true;
      }
    }

    await tx.activityLog.create({
      data: {
        entity: 'system',
        entityId: turnover.systemId,
        action: complete ? 'turnover_close' : 'turnover_task',
        actor: by,
        meta: { turnover_id: turnoverId, key, complete, flag_cleared: flagCleared } as Prisma.InputJsonValue,
      },
    });

    return { turnover: updated, complete, flag_cleared: flagCleared };
  });
}

/** Open cases with their SLA position — day 14 is the Today escalation (P6). */
export async function listTurnovers(includeClosed = false, now = new Date()) {
  const cases = await prisma.turnoverCase.findMany({
    where: includeClosed ? {} : { closedAt: null },
    include: {
      system: {
        select: {
          id: true,
          addressLine: true,
          unitLabel: true,
          flags: true,
          property: { select: { id: true, name: true } },
          resident: { select: { name: true, edcAccountName: true } },
        },
      },
    },
    orderBy: { openedAt: 'asc' },
  });

  return cases.map((c) => {
    const tasks = ((c.tasks as Tasks) ?? {}) as Tasks;
    const done = TURNOVER_TASKS.filter((k) => tasks[k] != null && tasks[k] !== false && tasks[k] !== '');
    return {
      id: c.id,
      system_id: c.systemId,
      address: c.system.addressLine,
      unit_label: c.system.unitLabel,
      property: c.system.property?.name ?? null,
      resident: c.system.resident?.name ?? null,
      opened_at: c.openedAt,
      sla_due: c.slaDue,
      closed_at: c.closedAt,
      age_days: daysBetween(c.openedAt, now),
      days_to_sla: c.slaDue ? daysBetween(now, c.slaDue) : null,
      tasks: TURNOVER_TASKS.map((k) => ({ key: k, value: tasks[k] ?? null, done: done.includes(k) })),
      artifacts_on_file: done.length,
      flagged: c.system.flags.includes('TURNOVER'),
    };
  });
}

/**
 * Name-mismatch check used at statement reconciliation: the program is paying
 * an account name that no longer matches the resident on record, which is how a
 * move-out most often reaches us — nobody tells us, the statement does.
 */
export async function checkNameMismatch(
  systemId: string,
  statementName: string,
  by: string | null,
): Promise<{ mismatch: boolean; turnover_id?: string; detail?: string }> {
  const system = await prisma.system.findUnique({ where: { id: systemId }, include: { resident: true } });
  if (!system) return { mismatch: false };

  const known = [system.edcAccountName, system.resident?.edcAccountName, system.resident?.name]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());
  if (known.length === 0) return { mismatch: false };

  const incoming = statementName.trim().toLowerCase();
  if (known.includes(incoming)) return { mismatch: false };

  // Already tracking a move-out on this unit — do not stack a second case.
  const open = await prisma.turnoverCase.findFirst({ where: { systemId, closedAt: null } });
  if (open) return { mismatch: true, turnover_id: open.id, detail: 'already tracked by an open turnover case' };

  const opened = await reportMoveOut(systemId, {
    reason: `Statement pays "${statementName}"; resident of record is "${system.resident?.name ?? system.edcAccountName}"`,
    by,
  });
  return {
    mismatch: true,
    turnover_id: opened.turnover.id,
    detail: `name mismatch at reconciliation — turnover opened`,
  };
}
