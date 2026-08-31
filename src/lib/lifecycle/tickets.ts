/**
 * Ticket lifecycle and RMA (03 §Service; 02 §Automations).
 *
 *   NEW → TRIAGED → REMOTE_ATTEMPTED → FIELD_NEEDED → SCHEDULED → ON_SITE
 *       → RESOLVED → VERIFIED → CLOSED
 *
 * Forward skips are allowed where they are real (a remote fix goes straight to
 * RESOLVED); the one transition nobody may hand-write is VERIFIED. That state
 * belongs to the machine: `verifyTicket` runs the rule's own check, and this
 * module refuses a manual attempt with a 409 pointing at it. A tech claiming
 * "fixed" moves a ticket to RESOLVED and no further.
 */
import type { Prisma, ResolutionCode, TicketState } from '@prisma/client';
import prisma from '../../config/database';
import { LifecycleError } from './errors';
import { notify } from './notifications';

type Client = Prisma.TransactionClient | typeof prisma;

/** Allowed forward moves. Absent pairs are refused. */
const FLOW: Record<TicketState, TicketState[]> = {
  NEW: ['TRIAGED', 'REMOTE_ATTEMPTED', 'FIELD_NEEDED', 'RESOLVED'],
  TRIAGED: ['REMOTE_ATTEMPTED', 'FIELD_NEEDED', 'RESOLVED'],
  REMOTE_ATTEMPTED: ['FIELD_NEEDED', 'RESOLVED'],
  // Scheduling is reversible — a cancelled visit drops back to FIELD_NEEDED.
  FIELD_NEEDED: ['SCHEDULED', 'RESOLVED'],
  SCHEDULED: ['ON_SITE', 'FIELD_NEEDED', 'RESOLVED'],
  ON_SITE: ['RESOLVED', 'FIELD_NEEDED'],
  // A resolution that did not hold goes back to the field, not backwards to NEW.
  RESOLVED: ['VERIFIED', 'FIELD_NEEDED'],
  VERIFIED: ['CLOSED'],
  CLOSED: [],
};

export interface TransitionOpts {
  resolutionCode?: ResolutionCode;
  note?: string;
  by?: string | null;
}

/**
 * Move a ticket. RESOLVED requires a resolution code — "fixed" without saying
 * how is not a resolution. VERIFIED is machine-only.
 */
export async function transitionTicket(
  ticketId: string,
  to: TicketState,
  opts: TransitionOpts = {},
  client: Client = prisma,
) {
  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new LifecycleError(404, 'TICKET_NOT_FOUND', `No ticket ${ticketId}`);

  if (to === 'VERIFIED') {
    throw new LifecycleError(
      409,
      'MACHINE_VERIFY_REQUIRED',
      'VERIFIED is set by the rule\'s machine check, not by hand — POST /api/tickets/:id/verify',
    );
  }
  if (!FLOW[ticket.state].includes(to)) {
    throw new LifecycleError(409, 'BAD_TICKET_TRANSITION', `${ticket.state} → ${to} is not a valid move`);
  }
  if (to === 'RESOLVED' && !opts.resolutionCode && !ticket.resolutionCode) {
    throw new LifecycleError(400, 'RESOLUTION_CODE_REQUIRED', 'RESOLVED requires a resolution code');
  }

  const updated = await client.ticket.update({
    where: { id: ticketId },
    data: {
      state: to,
      ...(to === 'RESOLVED' ? { resolvedAt: new Date(), resolutionCode: opts.resolutionCode ?? ticket.resolutionCode } : {}),
    },
  });

  await client.activityLog.create({
    data: {
      entity: 'system',
      entityId: ticket.systemId,
      action: 'ticket_state',
      actor: opts.by ?? null,
      meta: { ticket_id: ticketId, from: ticket.state, to, note: opts.note ?? null } as Prisma.InputJsonValue,
    },
  });

  return updated;
}

/**
 * Append to the remote-attempt log. Remote steps are tried before anyone
 * drives out (02 §Automations); recording the attempt is what justifies a
 * FIELD_NEEDED escalation later.
 */
export async function logRemoteAttempt(
  ticketId: string,
  entry: { step: string; outcome: string; by?: string | null },
  client: Client = prisma,
) {
  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new LifecycleError(404, 'TICKET_NOT_FOUND', `No ticket ${ticketId}`);

  const log = [
    ...(ticket.remoteLog as Prisma.InputJsonValue[]),
    { step: entry.step, outcome: entry.outcome, at: new Date().toISOString(), by: entry.by ?? 'system' },
  ];
  const updated = await client.ticket.update({
    where: { id: ticketId },
    data: {
      remoteLog: log as Prisma.InputJsonValue[],
      // The first logged attempt moves a fresh ticket along on its own.
      ...(ticket.state === 'NEW' || ticket.state === 'TRIAGED' ? { state: 'REMOTE_ATTEMPTED' as TicketState } : {}),
    },
  });
  return updated;
}

// ==== RMA ===================================================================

export interface RmaInput {
  oldSerial: string;
  newSerial: string;
  claimNo?: string;
  /** SKU of the replacement, when it differs from the unit pulled. */
  sku?: string;
  dom?: boolean;
  by?: string | null;
}

/**
 * Record a battery swap (02 §Automations — "Battery serial swapped (RMA)").
 *
 * Four things have to happen together, so they happen in one transaction:
 *   1. an equipment lineage row — the pulled unit points at its replacement
 *      via `replaced_by`, and goes RMA_OUT rather than being deleted;
 *   2. an attestation pull for the new serial (queued; the doc arrives later);
 *   3. the ITC evidence file is refreshed — the claim's per-serial attestation
 *      checklist has to name the serial that is actually in the field;
 *   4. a note on the claim, so diligence can see the swap without archaeology.
 */
export async function recordRma(ticketId: string, input: RmaInput, client: Client = prisma) {
  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new LifecycleError(404, 'TICKET_NOT_FOUND', `No ticket ${ticketId}`);

  const old = await client.equipment.findUnique({ where: { serial: input.oldSerial } });
  if (!old) throw new LifecycleError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with serial ${input.oldSerial}`);
  if (old.systemId !== ticket.systemId) {
    throw new LifecycleError(409, 'EQUIPMENT_WRONG_SYSTEM', `${input.oldSerial} is not installed on this ticket's system`);
  }
  const clash = await client.equipment.findUnique({ where: { serial: input.newSerial } });
  if (clash) throw new LifecycleError(409, 'DUPLICATE_SERIAL', `Serial ${input.newSerial} already exists`);

  const now = new Date();

  // 1 — the replacement, then the lineage pointer on the unit being pulled.
  const replacement = await client.equipment.create({
    data: {
      systemId: ticket.systemId,
      kind: old.kind,
      serial: input.newSerial,
      sku: input.sku ?? old.sku,
      dom: input.dom ?? old.dom,
      status: 'INSTALLED',
      installedAt: now,
    },
  });
  await client.equipment.update({
    where: { id: old.id },
    data: { status: 'RMA_OUT', removedAt: now, rmaNo: input.claimNo ?? null, replacedById: replacement.id },
  });

  // 2 — the attestation for the new serial has to be pulled from the vendor.
  notify.reminder(ticket.systemId, `attestation_pull:${input.newSerial}`);

  // 3 + 4 — refresh the claim's evidence file and leave a note on it.
  const claim = await client.itcClaim.findUnique({ where: { systemId: ticket.systemId } });
  if (claim) {
    const evidence = (claim.evidence as Record<string, unknown> | null) ?? {};
    const attestations = { ...((evidence.serial_attestations as Record<string, unknown>) ?? {}) };
    delete attestations[input.oldSerial];
    // Null = still owed. The claim is not evidence-complete until it lands.
    attestations[input.newSerial] = null;

    const notes = [
      ...((evidence.notes as unknown[]) ?? []),
      {
        at: now.toISOString(),
        kind: 'rma',
        text: `RMA swap ${input.oldSerial} → ${input.newSerial}${input.claimNo ? ` (claim ${input.claimNo})` : ''}; attestation pending for the new serial.`,
        ticket_id: ticketId,
      },
    ];

    await client.itcClaim.update({
      where: { id: claim.id },
      data: {
        evidence: { ...evidence, serial_attestations: attestations, notes } as Prisma.InputJsonValue,
        // Evidence is no longer complete once a serial's attestation is owed.
        ...(claim.status === 'EVIDENCE_COMPLETE' ? { status: 'BASIS_LOCKED' as const } : {}),
      },
    });
  }

  const updated = await client.ticket.update({
    where: { id: ticketId },
    data: {
      rma: { claim_no: input.claimNo ?? null, old_serial: input.oldSerial, new_serial: input.newSerial } as Prisma.InputJsonValue,
      resolutionCode: 'HARDWARE_RMA',
      category: 'HARDWARE',
    },
  });

  await client.activityLog.create({
    data: {
      entity: 'system',
      entityId: ticket.systemId,
      action: 'rma',
      actor: input.by ?? null,
      meta: {
        ticket_id: ticketId,
        old_serial: input.oldSerial,
        new_serial: input.newSerial,
        claim_no: input.claimNo ?? null,
        evidence_refreshed: Boolean(claim),
      } as Prisma.InputJsonValue,
    },
  });

  return { ticket: updated, replaced: old.id, replacement };
}
