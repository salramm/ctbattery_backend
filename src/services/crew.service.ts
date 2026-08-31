/**
 * Crew day board (03 §Service — "columns per crew per day").
 *
 * INSTALL work orders and SERVICE tickets share one calendar because they
 * compete for the same trucks. Each crew column carries its licences and
 * capacity, so an over-booked day is visible rather than discovered on the
 * morning of. Annual inspection routes ride along as low-priority INSPECTION
 * work orders that absorb WATCH items.
 */
import type { Prisma, WoType } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, addDays } from '../lib/lifecycle';

/** Work-order types that consume crew capacity. */
const SCHEDULABLE: WoType[] = ['INSTALL', 'SERVICE', 'INSPECTION', 'TURNOVER'];

/** Low-priority work that fills a day rather than driving it. */
const LOW_PRIORITY: WoType[] = ['INSPECTION'];

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getBoard(fromDate?: Date, days = 7) {
  const from = fromDate ?? new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = addDays(from, days);

  const [crews, workOrders, unscheduled] = await Promise.all([
    prisma.crew.findMany({ include: { installer: true }, orderBy: { label: 'asc' } }),
    prisma.workOrder.findMany({
      where: { type: { in: SCHEDULABLE }, date: { gte: from, lt: to }, status: { not: 'CANCELLED' } },
      include: {
        system: { select: { id: true, addressLine: true, unitLabel: true, stage: true, property: { select: { town: true, name: true } } } },
        ticket: { select: { id: true, category: true, severity: true, state: true } },
      },
      orderBy: { date: 'asc' },
    }),
    // Work waiting for a slot — the board's inbox.
    prisma.workOrder.findMany({
      where: { type: { in: SCHEDULABLE }, status: { not: 'CANCELLED' }, OR: [{ date: null }, { crewId: null }] },
      include: {
        system: { select: { id: true, addressLine: true, unitLabel: true, property: { select: { town: true } } } },
        ticket: { select: { id: true, category: true, severity: true, state: true } },
      },
      take: 100,
    }),
  ]);

  const dayList = Array.from({ length: days }, (_, i) => dayKey(addDays(from, i)));

  const card = (wo: (typeof workOrders)[number]) => ({
    id: wo.id,
    type: wo.type,
    status: wo.status,
    date: wo.date,
    system_id: wo.systemId,
    address: wo.system?.addressLine ?? null,
    unit_label: wo.system?.unitLabel ?? null,
    town: wo.system?.property?.town ?? null,
    property: wo.system?.property?.name ?? null,
    route_group: wo.routeGroup,
    ticket: wo.ticket ?? null,
    low_priority: LOW_PRIORITY.includes(wo.type),
    checked_in: Boolean(wo.checkinAt),
    complete: wo.status === 'COMPLETE',
  });

  const columns = crews.map((crew) => {
    const mine = workOrders.filter((w) => w.crewId === crew.id);
    const byDay = dayList.map((day) => {
      const cards = mine.filter((w) => w.date && dayKey(w.date) === day).map(card);
      const capacity = crew.capacityPerDay ?? null;
      // Only work that actually consumes a slot counts against capacity.
      const load = cards.filter((c) => !c.low_priority).length;
      return {
        day,
        cards,
        load,
        capacity,
        over_capacity: capacity != null && load > capacity,
        // Towns on the day — the routing signal (03 — "routed by town").
        towns: [...new Set(cards.map((c) => c.town).filter(Boolean))] as string[],
      };
    });

    return {
      crew: {
        id: crew.id,
        label: crew.label,
        installer: crew.installer.orgName,
        self_perform: crew.installer.selfPerform,
        licences: crew.installer.licenseNos,
        members: crew.members,
        capacity_per_day: crew.capacityPerDay,
      },
      days: byDay,
    };
  });

  // Unassigned work orders that fall inside the window, plus anything undated.
  const inbox = unscheduled
    .filter((w) => !w.date || (w.date >= from && w.date < to))
    .map((wo) => ({
      id: wo.id,
      type: wo.type,
      status: wo.status,
      date: wo.date,
      system_id: wo.systemId,
      address: wo.system?.addressLine ?? null,
      unit_label: wo.system?.unitLabel ?? null,
      town: wo.system?.property?.town ?? null,
      ticket: wo.ticket ?? null,
      low_priority: LOW_PRIORITY.includes(wo.type),
    }));

  return { from, days: dayList, columns, inbox };
}

/**
 * Drop a work order on a crew/day (the board's drag). Reports over-capacity as
 * a warning rather than refusing — a dispatcher double-booking on purpose is a
 * judgment call, but it should never be invisible.
 */
export async function scheduleWorkOrder(
  workOrderId: string,
  input: { crewId?: string | null; date?: Date | null; routeGroup?: string; by?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const wo = await tx.workOrder.findUnique({ where: { id: workOrderId } });
    if (!wo) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${workOrderId}`);
    if (wo.status === 'COMPLETE' || wo.checkoutAt) {
      throw new LifecycleError(409, 'WORK_ORDER_COMPLETE', 'A completed work order cannot be rescheduled');
    }

    const crewId = input.crewId === undefined ? wo.crewId : input.crewId;
    const date = input.date === undefined ? wo.date : input.date;

    if (crewId) {
      const crew = await tx.crew.findUnique({ where: { id: crewId } });
      if (!crew) throw new LifecycleError(404, 'CREW_NOT_FOUND', `No crew ${crewId}`);
    }

    const updated = await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        crewId,
        date,
        routeGroup: input.routeGroup ?? wo.routeGroup,
        status: crewId && date ? 'SCHEDULED' : 'DRAFT',
      },
    });

    // Keep the linked ticket's state honest about whether a visit is booked.
    if (wo.ticketId) {
      const ticket = await tx.ticket.findUnique({ where: { id: wo.ticketId } });
      if (ticket && ['NEW', 'TRIAGED', 'REMOTE_ATTEMPTED', 'FIELD_NEEDED', 'SCHEDULED'].includes(ticket.state)) {
        await tx.ticket.update({
          where: { id: ticket.id },
          data: { state: crewId && date ? 'SCHEDULED' : 'FIELD_NEEDED' },
        });
      }
    }

    // Capacity warning for the day just filled.
    let warning: string | null = null;
    if (crewId && date) {
      const crew = await tx.crew.findUniqueOrThrow({ where: { id: crewId } });
      if (crew.capacityPerDay != null) {
        const start = new Date(date);
        start.setUTCHours(0, 0, 0, 0);
        const load = await tx.workOrder.count({
          where: {
            crewId,
            date: { gte: start, lt: addDays(start, 1) },
            status: { not: 'CANCELLED' },
            type: { notIn: LOW_PRIORITY },
          },
        });
        if (load > crew.capacityPerDay) {
          warning = `${crew.label} is at ${load} of ${crew.capacityPerDay} for ${dayKey(start)}`;
        }
      }
    }

    if (updated.systemId) {
      await tx.activityLog.create({
        data: {
          entity: 'system',
          entityId: updated.systemId,
          action: 'wo_schedule',
          actor: input.by ?? null,
          meta: { work_order_id: workOrderId, crew_id: crewId, date } as Prisma.InputJsonValue,
        },
      });
    }

    return { work_order: updated, warning };
  });
}
