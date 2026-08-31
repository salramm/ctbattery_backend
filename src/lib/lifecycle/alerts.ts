/**
 * Alerts engine (01 §Alert rules — Flow C; 02 §Automations).
 *
 * The `alert_rules` seed owns each rule's severity, trigger text, auto-action
 * and verify description. This module owns the *mechanics* the prose implies:
 * whether the rule opens a ticket, which category it lands in, what remote
 * steps queue first, and — the important one — the machine check that has to
 * pass before a claimed resolution becomes VERIFIED.
 *
 * "Ticket per severity mapping" is not simply FAULT⇒ticket: the seed's
 * auto-action column distinguishes offline_4h (WATCH, resident SMS, no ticket)
 * from event_low_2x (WATCH, investigation ticket). The registry encodes that.
 *
 * A tech's word never closes a ticket. `verifyTicket` runs the rule's own check;
 * only when it passes does the ticket go RESOLVED → VERIFIED → CLOSED.
 */
import type { Prisma, System, TicketCategory } from '@prisma/client';
import prisma from '../../config/database';
import { recomputeHealth } from './health';
import { hasCleanTelemetry, readOne } from './telemetry';
import { notify } from './notifications';

type Client = Prisma.TransactionClient | typeof prisma;

export interface RuleSpec {
  /** Open a ticket automatically when the alert fires. */
  ticket: boolean;
  category: TicketCategory;
  /** Queued before anyone drives anywhere (02 — "remote steps queued first"). */
  remoteSteps?: string[];
  /** Extra handling the seed's auto-action text calls for. */
  smsTemplate?: string;
  safetyFlag?: boolean;
  /**
   * The machine check that must pass to move a claimed resolution to VERIFIED.
   * Returning false leaves the ticket RESOLVED — visibly unverified.
   */
  verify(system: System, client: Client, now: Date): Promise<boolean>;
}

/** Hours of unbroken telemetry that close an offline ticket (seed: "48h clean telemetry"). */
const CLEAN_TELEMETRY_HOURS = 48;

export const RULES: Record<string, RuleSpec> = {
  // Gateway offline > 4h — WATCH; resident SMS, no ticket.
  offline_4h: {
    ticket: false,
    category: 'COMMS',
    smsTemplate: 'resident_offline_check',
    // "reporting resumes"
    verify: async (system, client, now) => {
      const read = await readOne(system, client, now);
      return read?.hoursSinceSeen != null && read.hoursSinceSeen < 4;
    },
  },

  // Gateway offline > 24h — FAULT; ticket + remote steps queued.
  offline_24h: {
    ticket: true,
    category: 'COMMS',
    remoteSteps: ['ping gateway', 'remote reboot', 'confirm WAN/cell link', 'reprovision if still dark'],
    // "48h clean telemetry"
    verify: async (system, client, now) => hasCleanTelemetry(system, CLEAN_TELEMETRY_HOURS, client, now),
  },

  // 0 kW delivered at an event — FAULT; ticket carries the event context.
  event_zero: {
    ticket: true,
    category: 'PERFORMANCE',
    // "next event kW > 0"
    verify: async (system, client) => {
      const next = await client.event.findFirst({
        where: { systemId: system.id, kwDelivered: { not: null } },
        orderBy: { date: 'desc' },
      });
      return next?.kwDelivered != null && Number(next.kwDelivered) > 0;
    },
  },

  // ratio < 70% twice in a season — WATCH, but still an investigation ticket.
  event_low_2x: {
    ticket: true,
    category: 'PERFORMANCE',
    // "ratio ≥ 90% next event"
    verify: async (system, client) => {
      const next = await client.event.findFirst({
        where: { systemId: system.id, ratio: { not: null } },
        orderBy: { date: 'desc' },
      });
      return next?.ratio != null && Number(next.ratio) >= 0.9;
    },
  },

  // 30-day comms < 95% — WATCH; flag and batch into a route, no ticket.
  comms_30d: {
    ticket: false,
    category: 'COMMS',
    // "30-day ≥ 97%"
    verify: async (system, client, now) => {
      const read = await readOne(system, client, now);
      return read?.comms30 != null && read.comms30 >= 0.97;
    },
  },

  // Hardware fault / thermal — FAULT; RMA path pre-suggested.
  hw_fault: {
    ticket: true,
    category: 'HARDWARE',
    remoteSteps: ['read fault register', 'clear latched fault', 'stage RMA if it re-latches'],
    // "fault clear + clean event"
    verify: async (system, client, _now) => {
      const stillOpen = await client.alert.count({ where: { systemId: system.id, ruleKey: 'hw_fault', clearedAt: null } });
      if (stillOpen > 0) return false;
      const lastEvent = await client.event.findFirst({
        where: { systemId: system.id, kwDelivered: { not: null } },
        orderBy: { date: 'desc' },
      });
      return lastEvent?.kwDelivered != null && Number(lastEvent.kwDelivered) > 0;
    },
  },

  // Resident/PM safety report — FAULT; same-week priority, safety flag.
  physical: {
    ticket: true,
    category: 'PHYSICAL',
    safetyFlag: true,
    // "field sign-off" — there is no machine check for a human eyeballing a
    // battery, so this never self-verifies. A completed SERVICE work order is
    // the sign-off.
    verify: async (system, client) => {
      const signedOff = await client.workOrder.count({
        where: { systemId: system.id, type: 'SERVICE', status: 'COMPLETE', checkoutAt: { not: null } },
      });
      return signedOff > 0;
    },
  },
};

// ==== opening and clearing ==================================================

export interface OpenAlertResult {
  alertId: string;
  ticketId: string | null;
  created: boolean;
}

/**
 * Open an alert for a rule, idempotently: a rule already open on a system does
 * not stack a second alert or a second ticket. Fires the rule's auto-action,
 * then recomputes the health cache.
 */
export async function openAlert(
  systemId: string,
  ruleKey: string,
  context: Record<string, unknown> = {},
  client: Client = prisma,
): Promise<OpenAlertResult> {
  const rule = await client.alertRule.findUnique({ where: { key: ruleKey } });
  if (!rule) throw new Error(`Unknown alert rule ${ruleKey}`);
  const spec = RULES[ruleKey];

  const existing = await client.alert.findFirst({ where: { systemId, ruleKey, clearedAt: null } });
  if (existing) return { alertId: existing.id, ticketId: existing.ticketId, created: false };

  const alert = await client.alert.create({
    data: { systemId, ruleKey, severity: rule.severity, context: context as Prisma.InputJsonValue },
  });

  let ticketId: string | null = null;
  if (spec?.ticket) {
    const ticket = await client.ticket.create({
      data: {
        systemId,
        category: spec.category,
        source: 'auto',
        severity: rule.severity,
        state: 'NEW',
        linkedAlertId: alert.id,
        // Remote steps are queued before any field visit is considered.
        remoteLog: (spec.remoteSteps ?? []).map((step) => ({ step, state: 'QUEUED' })) as Prisma.InputJsonValue[],
        warrantyFlag: await warrantyApplies(systemId, client),
      },
    });
    ticketId = ticket.id;
    await client.alert.update({ where: { id: alert.id }, data: { ticketId } });
  }

  if (spec?.smsTemplate) notify.sms(systemId, spec.smsTemplate);
  if (spec?.safetyFlag) notify.reminder(systemId, 'safety_priority');

  await client.activityLog.create({
    data: {
      entity: 'system',
      entityId: systemId,
      action: 'alert_open',
      actor: 'system',
      meta: { rule: ruleKey, severity: rule.severity, ticket_id: ticketId, ...context } as Prisma.InputJsonValue,
    },
  });

  await recomputeHealth(systemId, client);
  return { alertId: alert.id, ticketId, created: true };
}

/** 01 §Derived — warranty_flag: inside the workmanship window and sub-installed. */
async function warrantyApplies(systemId: string, client: Client): Promise<boolean> {
  const system = await client.system.findUnique({
    where: { id: systemId },
    select: { warrantyEnd: true, installerOfRecord: true },
  });
  if (!system?.warrantyEnd || new Date() >= system.warrantyEnd) return false;
  const ior = system.installerOfRecord as { installer_org?: string | null; self_perform?: boolean } | null;
  return Boolean(ior?.installer_org) && ior?.self_perform !== true;
}

/**
 * Clear an open alert once its condition resolves. The machine saw the fix, so
 * a linked ticket is claimed RESOLVED (remote fix) and immediately put through
 * the rule's own verification — which may or may not pass yet.
 */
export async function clearAlert(
  systemId: string,
  ruleKey: string,
  client: Client = prisma,
  now = new Date(),
): Promise<boolean> {
  const alert = await client.alert.findFirst({ where: { systemId, ruleKey, clearedAt: null } });
  if (!alert) return false;

  await client.alert.update({ where: { id: alert.id }, data: { clearedAt: now } });
  await client.activityLog.create({
    data: { entity: 'system', entityId: systemId, action: 'alert_clear', actor: 'system', meta: { rule: ruleKey } },
  });

  if (alert.ticketId) {
    const ticket = await client.ticket.findUnique({ where: { id: alert.ticketId } });
    if (ticket && !['RESOLVED', 'VERIFIED', 'CLOSED'].includes(ticket.state)) {
      await client.ticket.update({
        where: { id: ticket.id },
        data: { state: 'RESOLVED', resolutionCode: 'REMOTE_FIX', resolvedAt: now },
      });
    }
    await verifyTicket(alert.ticketId, client, now);
  }

  await recomputeHealth(systemId, client);
  return true;
}

// ==== verification ==========================================================

/**
 * Run the rule's machine check against a claimed resolution. Passing moves the
 * ticket VERIFIED → CLOSED; failing leaves it RESOLVED so the queue still shows
 * it as unproven (02 §Automations).
 */
export async function verifyTicket(ticketId: string, client: Client = prisma, now = new Date()): Promise<boolean> {
  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.state !== 'RESOLVED') return false;

  const alert = ticket.linkedAlertId
    ? await client.alert.findUnique({ where: { id: ticket.linkedAlertId } })
    : null;
  const spec = alert?.ruleKey ? RULES[alert.ruleKey] : undefined;
  if (!spec) return false;

  const system = await client.system.findUnique({ where: { id: ticket.systemId } });
  if (!system) return false;

  const passes = await spec.verify(system, client, now);
  if (!passes) return false;

  // VERIFIED is a real state, not a flag on the way past: the machine check
  // passed, and only then does the ticket close (02 §Automations — "VERIFIED
  // only when the rule's machine check passes; then CLOSED").
  await client.ticket.update({ where: { id: ticketId }, data: { state: 'VERIFIED', verifiedAt: now } });
  await client.ticket.update({ where: { id: ticketId }, data: { state: 'CLOSED' } });
  await client.activityLog.create({
    data: {
      entity: 'system',
      entityId: ticket.systemId,
      action: 'ticket_verified',
      actor: 'system',
      meta: { ticket_id: ticketId, rule: alert?.ruleKey ?? null } as Prisma.InputJsonValue,
    },
  });
  await recomputeHealth(ticket.systemId, client);
  return true;
}

/**
 * Sweep claimed resolutions and verify the ones whose check now passes.
 * `systemIds` scopes the sweep — a scoped poll must not reach past its own set.
 */
export async function runVerifications(
  client: Client = prisma,
  now = new Date(),
  systemIds?: string[],
): Promise<number> {
  const resolved = await client.ticket.findMany({
    where: { state: 'RESOLVED', ...(systemIds ? { systemId: { in: systemIds } } : {}) },
    select: { id: true },
  });
  let verified = 0;
  for (const t of resolved) if (await verifyTicket(t.id, client, now)) verified += 1;
  return verified;
}

/** Manual [Open ticket] from the Today queue, for a rule that files none itself. */
export async function openTicketForAlert(alertId: string, by: string | null, client: Client = prisma) {
  const alert = await client.alert.findUnique({ where: { id: alertId } });
  if (!alert) return null;
  if (alert.ticketId) return client.ticket.findUnique({ where: { id: alert.ticketId } });

  const spec = alert.ruleKey ? RULES[alert.ruleKey] : undefined;
  const ticket = await client.ticket.create({
    data: {
      systemId: alert.systemId,
      category: spec?.category ?? 'COMMS',
      source: 'auto',
      severity: alert.severity,
      state: 'NEW',
      linkedAlertId: alert.id,
      remoteLog: (spec?.remoteSteps ?? []).map((step) => ({ step, state: 'QUEUED' })) as Prisma.InputJsonValue[],
      warrantyFlag: await warrantyApplies(alert.systemId, client),
    },
  });
  await client.alert.update({ where: { id: alertId }, data: { ticketId: ticket.id } });
  await client.activityLog.create({
    data: {
      entity: 'system',
      entityId: alert.systemId,
      action: 'ticket_open',
      actor: by,
      meta: { ticket_id: ticket.id, alert_id: alertId } as Prisma.InputJsonValue,
    },
  });
  await recomputeHealth(alert.systemId, client);
  return ticket;
}

// ==== event-driven rules ====================================================

/**
 * Evaluate the rules that fire on dispatch data rather than telemetry. Called
 * by the events importer as each row lands (P9 owns the import; this is the
 * hook it calls).
 */
export async function evaluateEventRules(eventId: string, client: Client = prisma): Promise<string[]> {
  const event = await client.event.findUnique({ where: { id: eventId } });
  if (!event) return [];
  const fired: string[] = [];

  const delivered = event.kwDelivered != null ? Number(event.kwDelivered) : null;
  const ratio = event.ratio != null ? Number(event.ratio) : null;

  // 0 kW delivered at an event.
  if (delivered === 0) {
    await openAlert(
      event.systemId,
      'event_zero',
      { event_id: event.id, date: event.date.toISOString(), window: event.window },
      client,
    );
    fired.push('event_zero');
  }

  // ratio < 70% twice in the same season.
  if (ratio != null && ratio < 0.7 && event.seasonId) {
    const lows = await client.event.count({
      where: { systemId: event.systemId, seasonId: event.seasonId, ratio: { lt: 0.7 } },
    });
    if (lows >= 2) {
      await openAlert(event.systemId, 'event_low_2x', { season_id: event.seasonId, lows }, client);
      fired.push('event_low_2x');
    }
  }

  // A good event answers the two performance rules (01 §Alert rules — verify).
  if (delivered != null && delivered > 0) {
    if (await clearAlert(event.systemId, 'event_zero', client)) fired.push('event_zero:cleared');
    if (ratio != null && ratio >= 0.9) {
      if (await clearAlert(event.systemId, 'event_low_2x', client)) fired.push('event_low_2x:cleared');
    }
  }

  return fired;
}
