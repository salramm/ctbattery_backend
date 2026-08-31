/**
 * Service — the ticket queue and detail (03 §Service).
 *
 * Queue is severity-sorted; detail carries everything needed to judge the
 * ticket without leaving it: the alert or event that opened it, the
 * remote-attempt log, the installer of record, the warranty flag, the RMA
 * fields and the resolution code. VERIFIED is never shown as something a human
 * can click — it comes from the rule's machine check.
 */
import type { Prisma, TicketState } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, RULES, daysBetween } from '../lib/lifecycle';

/** Open states, worst first. CLOSED drops out of the working queue. */
const OPEN_STATES: TicketState[] = [
  'NEW',
  'TRIAGED',
  'REMOTE_ATTEMPTED',
  'FIELD_NEEDED',
  'SCHEDULED',
  'ON_SITE',
  'RESOLVED',
  'VERIFIED',
];

const STATE_RANK: Record<string, number> = {
  NEW: 0,
  TRIAGED: 1,
  REMOTE_ATTEMPTED: 2,
  FIELD_NEEDED: 3,
  SCHEDULED: 4,
  ON_SITE: 5,
  RESOLVED: 6,
  VERIFIED: 7,
  CLOSED: 8,
};

export interface QueueFilters {
  state?: TicketState;
  category?: string;
  includeClosed?: boolean;
}

export async function getQueue(filters: QueueFilters = {}, now = new Date()) {
  const tickets = await prisma.ticket.findMany({
    where: {
      ...(filters.state ? { state: filters.state } : filters.includeClosed ? {} : { state: { in: OPEN_STATES } }),
      ...(filters.category ? { category: filters.category as never } : {}),
    },
    include: {
      system: { select: { id: true, addressLine: true, unitLabel: true, property: { select: { name: true, town: true } } } },
      workOrder: { include: { crew: { select: { id: true, label: true } } } },
    },
  });

  const rows = tickets.map((t) => ({
    id: t.id,
    system_id: t.systemId,
    address: t.system.addressLine,
    property: t.system.property?.name ?? null,
    town: t.system.property?.town ?? null,
    category: t.category,
    source: t.source,
    severity: t.severity,
    state: t.state,
    age_days: daysBetween(t.createdAt, now),
    crew: t.workOrder?.crew ? { id: t.workOrder.crew.id, label: t.workOrder.crew.label } : null,
    work_order_id: t.workOrderId,
    warranty_flag: t.warrantyFlag,
    resolution_code: t.resolutionCode,
    has_rma: Boolean(t.rma),
    created_at: t.createdAt,
  }));

  // Severity first (FAULT before WATCH), then how far from done, then age.
  rows.sort((a, b) => {
    const sev = (a.severity === 'FAULT' ? 0 : 1) - (b.severity === 'FAULT' ? 0 : 1);
    if (sev !== 0) return sev;
    const st = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    if (st !== 0) return st;
    return b.age_days - a.age_days;
  });

  return {
    tickets: rows,
    counts: {
      open: rows.filter((r) => r.state !== 'CLOSED').length,
      field_needed: rows.filter((r) => r.state === 'FIELD_NEEDED').length,
      faults: rows.filter((r) => r.severity === 'FAULT' && r.state !== 'CLOSED').length,
    },
  };
}

export async function getTicket(id: string, now = new Date()) {
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      system: {
        select: {
          id: true,
          addressLine: true,
          unitLabel: true,
          stage: true,
          health: true,
          installerOfRecord: true,
          warrantyEnd: true,
          property: { select: { id: true, name: true, town: true } },
          equipment: {
            where: { status: { in: ['INSTALLED', 'RMA_OUT'] } },
            select: { id: true, serial: true, kind: true, sku: true, status: true, replacedById: true, rmaNo: true, installedAt: true, removedAt: true },
          },
        },
      },
      workOrder: { include: { crew: { include: { installer: true } } } },
      linkedEvent: true,
    },
  });
  if (!ticket) throw new LifecycleError(404, 'TICKET_NOT_FOUND', `No ticket ${id}`);

  const alert = ticket.linkedAlertId
    ? await prisma.alert.findUnique({ where: { id: ticket.linkedAlertId }, include: { rule: true } })
    : null;
  const spec = alert?.ruleKey ? RULES[alert.ruleKey] : undefined;

  return {
    id: ticket.id,
    system: {
      id: ticket.system.id,
      address: ticket.system.addressLine,
      unit_label: ticket.system.unitLabel,
      stage: ticket.system.stage,
      health: ticket.system.health,
      property: ticket.system.property,
    },
    category: ticket.category,
    source: ticket.source,
    severity: ticket.severity,
    state: ticket.state,
    age_days: daysBetween(ticket.createdAt, now),
    created_at: ticket.createdAt,

    // Why it exists.
    alert: alert
      ? {
          id: alert.id,
          rule_key: alert.ruleKey,
          trigger: alert.rule?.triggerDesc ?? null,
          auto_action: alert.rule?.autoAction ?? null,
          verify_desc: alert.rule?.verifyDesc ?? null,
          opened_at: alert.openedAt,
          cleared_at: alert.clearedAt,
          context: alert.context,
        }
      : null,
    event: ticket.linkedEvent
      ? {
          id: ticket.linkedEvent.id,
          date: ticket.linkedEvent.date,
          window: ticket.linkedEvent.window,
          kw_delivered: ticket.linkedEvent.kwDelivered,
          ratio: ticket.linkedEvent.ratio,
        }
      : null,

    remote_log: ticket.remoteLog,
    remote_steps_suggested: spec?.remoteSteps ?? [],

    // 03 §Service — installer of record is ALWAYS displayed.
    installer_of_record: ticket.system.installerOfRecord,
    warranty_flag: ticket.warrantyFlag,
    warranty_end: ticket.system.warrantyEnd,

    rma: ticket.rma,
    resolution_code: ticket.resolutionCode,
    resolved_at: ticket.resolvedAt,
    verified_at: ticket.verifiedAt,
    /** What the machine will check before this can be VERIFIED. */
    verify_check: alert?.rule?.verifyDesc ?? null,

    work_order: ticket.workOrder
      ? {
          id: ticket.workOrder.id,
          type: ticket.workOrder.type,
          status: ticket.workOrder.status,
          date: ticket.workOrder.date,
          crew: ticket.workOrder.crew
            ? {
                id: ticket.workOrder.crew.id,
                label: ticket.workOrder.crew.label,
                installer: ticket.workOrder.crew.installer.orgName,
                members: ticket.workOrder.crew.members,
              }
            : null,
        }
      : null,

    equipment: ticket.system.equipment,
  };
}

/**
 * Put a ticket in the field: create (or reuse) a SERVICE work order and link it
 * both ways, moving the ticket to SCHEDULED when a crew and date are supplied.
 */
export async function assignTicket(
  ticketId: string,
  input: { crewId?: string; date?: Date; routeGroup?: string; by?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new LifecycleError(404, 'TICKET_NOT_FOUND', `No ticket ${ticketId}`);
    if (ticket.state === 'CLOSED') throw new LifecycleError(409, 'TICKET_CLOSED', 'Closed tickets cannot be assigned');

    let workOrder = ticket.workOrderId ? await tx.workOrder.findUnique({ where: { id: ticket.workOrderId } }) : null;

    if (workOrder) {
      workOrder = await tx.workOrder.update({
        where: { id: workOrder.id },
        data: {
          crewId: input.crewId ?? workOrder.crewId,
          date: input.date ?? workOrder.date,
          routeGroup: input.routeGroup ?? workOrder.routeGroup,
          status: input.crewId && input.date ? 'SCHEDULED' : workOrder.status,
        },
      });
    } else {
      workOrder = await tx.workOrder.create({
        data: {
          systemId: ticket.systemId,
          type: 'SERVICE',
          crewId: input.crewId ?? null,
          date: input.date ?? null,
          routeGroup: input.routeGroup ?? null,
          status: input.crewId && input.date ? 'SCHEDULED' : 'DRAFT',
          ticketId: ticket.id,
        },
      });
      await tx.ticket.update({ where: { id: ticket.id }, data: { workOrderId: workOrder.id } });
    }

    // Ticket state follows the work order: a booked visit is SCHEDULED, an
    // unbooked one is still FIELD_NEEDED.
    const target: TicketState = workOrder.crewId && workOrder.date ? 'SCHEDULED' : 'FIELD_NEEDED';
    const current = (await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } })).state;
    if (current !== target && ['NEW', 'TRIAGED', 'REMOTE_ATTEMPTED', 'FIELD_NEEDED', 'SCHEDULED'].includes(current)) {
      await tx.ticket.update({ where: { id: ticketId }, data: { state: target } });
    }

    await tx.activityLog.create({
      data: {
        entity: 'system',
        entityId: ticket.systemId,
        action: 'ticket_assign',
        actor: input.by ?? null,
        meta: { ticket_id: ticketId, work_order_id: workOrder.id, crew_id: workOrder.crewId, date: workOrder.date } as Prisma.InputJsonValue,
      },
    });

    return { ticket: await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } }), work_order: workOrder };
  });
}
