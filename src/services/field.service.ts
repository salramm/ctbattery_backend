/**
 * Field surface (03 §Field mobile). One screen per work order, phone-first.
 *
 * The crew's whole day is: check in (GPS + time) → work the S07 checklist as
 * tap targets with camera prompts → scan serials → confirm activation → take
 * the resident's signature → check out. Check-out is the moment
 * `installer_of_record` is stamped (L6), which is why it is the one step that
 * refuses to run early.
 *
 * Offline tolerance is a sync contract, not a cache: the phone queues ops with
 * client-side ids and replays them whenever it next has signal. Every op is
 * idempotent, so replaying a queue that partially landed is safe.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { LifecycleError, applyChecklist, onWorkOrderCheckin, onWorkOrderCheckout } from '../lib/lifecycle';

/** The S07 field checklist, in the order the crew works it (01 §Seed). */
export const FIELD_SEQUENCE = [
  { key: 'pre_photos', label: 'Pre-install photos', camera: true },
  { key: 'mount_complete', label: 'Mount complete', camera: true },
  { key: 'collar_set', label: 'Meter collar set', camera: true },
  { key: 'wired_breakered', label: 'Wired and breakered', camera: true },
  { key: 'energized_backup_test', label: 'Energized · backup test', camera: false },
  { key: 'post_photos', label: 'Post-install photos', camera: true },
  { key: 'serials_scanned', label: 'Serials scanned', camera: false },
  { key: 'enlighten_activated', label: 'Enlighten activated', camera: false },
  { key: 'grid_profile_fw', label: 'Grid profile + firmware', camera: false },
  { key: 'comms_verified_both', label: 'Comms verified (both paths)', camera: false },
  { key: 'resident_walkthrough', label: 'Resident walkthrough', camera: false },
];

/** Set by the poller, never by the crew (01 §Seed — auto-only). */
const AUTO_ONLY = new Set(['telemetry_confirmed']);

/**
 * Work orders a field user may see. The FIELD role is scoped to its own crew's
 * assigned work — never the whole board.
 */
export async function listAssigned(opts: { crewId?: string; role: string; from?: Date; to?: Date }) {
  if (opts.role === 'FIELD' && !opts.crewId) {
    // A field user with no crew has no work; returning everything would be a
    // scope leak, so return nothing and say why.
    return { work_orders: [], note: 'No crew is linked to this field account.' };
  }

  const work_orders = await prisma.workOrder.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'COMPLETE'] },
      ...(opts.crewId ? { crewId: opts.crewId } : {}),
      ...(opts.from || opts.to ? { date: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
    },
    include: {
      system: { select: { id: true, addressLine: true, unitLabel: true, stage: true, property: { select: { town: true, name: true } } } },
      ticket: { select: { id: true, category: true, severity: true, state: true } },
      crew: { select: { id: true, label: true } },
    },
    orderBy: [{ date: 'asc' }],
  });

  return {
    work_orders: work_orders.map((wo) => ({
      id: wo.id,
      type: wo.type,
      status: wo.status,
      date: wo.date,
      address: wo.system?.addressLine ?? null,
      unit_label: wo.system?.unitLabel ?? null,
      town: wo.system?.property?.town ?? null,
      crew: wo.crew,
      ticket: wo.ticket,
      checked_in: Boolean(wo.checkinAt),
    })),
  };
}

/** Everything one work-order screen needs, in one call — phones get one trip. */
export async function getWorkOrder(id: string, opts: { crewId?: string; role: string }) {
  const wo = await prisma.workOrder.findUnique({
    where: { id },
    include: {
      system: {
        select: {
          id: true,
          addressLine: true,
          unitLabel: true,
          stage: true,
          enlightenSiteId: true,
          gridProfile: true,
          fwVersion: true,
          property: { select: { name: true, town: true, lat: true, lng: true } },
          resident: { select: { name: true, phone: true } },
          equipment: { select: { id: true, serial: true, kind: true, sku: true, status: true } },
        },
      },
      crew: { include: { installer: true } },
      ticket: true,
    },
  });
  if (!wo) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);
  if (opts.role === 'FIELD' && wo.crewId !== opts.crewId) {
    throw new LifecycleError(403, 'NOT_ASSIGNED', 'This work order is not assigned to your crew');
  }

  const checklist = wo.systemId
    ? await prisma.checklistItem.findMany({
        where: { systemId: wo.systemId, stage: 'S07_INSTALLED' },
        orderBy: { key: 'asc' },
      })
    : [];
  const byKey = new Map(checklist.map((c) => [c.key, c]));

  return {
    id: wo.id,
    type: wo.type,
    status: wo.status,
    date: wo.date,
    checkin_at: wo.checkinAt,
    checkout_at: wo.checkoutAt,
    photos: wo.photos ?? [],
    system: wo.system
      ? {
          id: wo.system.id,
          address: wo.system.addressLine,
          unit_label: wo.system.unitLabel,
          stage: wo.system.stage,
          property: wo.system.property,
          resident: wo.system.resident,
          enlighten_site_id: wo.system.enlightenSiteId,
          grid_profile: wo.system.gridProfile,
          fw: wo.system.fwVersion,
          equipment: wo.system.equipment,
        }
      : null,
    crew: wo.crew
      ? { id: wo.crew.id, label: wo.crew.label, installer: wo.crew.installer.orgName, members: wo.crew.members }
      : null,

    // INSTALL work: the S07 sequence as tap targets.
    checklist:
      wo.type === 'INSTALL'
        ? FIELD_SEQUENCE.map((step) => {
            const item = byKey.get(step.key);
            return {
              ...step,
              state: item?.state ?? 'OPEN',
              done_at: item?.doneAt ?? null,
              done_by: item?.doneBy ?? null,
              instantiated: Boolean(item),
            };
          })
        : [],

    // SERVICE work: the remote history and the codes available to close it.
    ticket: wo.ticket
      ? {
          id: wo.ticket.id,
          category: wo.ticket.category,
          severity: wo.ticket.severity,
          state: wo.ticket.state,
          remote_log: wo.ticket.remoteLog,
          resolution_code: wo.ticket.resolutionCode,
          warranty_flag: wo.ticket.warrantyFlag,
          rma: wo.ticket.rma,
        }
      : null,
    resolution_codes: ['REMOTE_FIX', 'HARDWARE_RMA', 'WIRING', 'RESIDENT_ACTION', 'NO_FAULT'],
  };
}

// ==== the day's steps =======================================================

export async function checkIn(id: string, gps: { lat?: number; lng?: number } | undefined, by: string | null) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);
  if (wo.checkinAt) return { work_order: wo, already: true }; // idempotent replay

  if (wo.systemId) {
    // Drives AUTO S06→S07 for an install (02 §Transitions).
    await onWorkOrderCheckin(wo.systemId, id, { by });
  } else {
    await prisma.workOrder.update({ where: { id }, data: { checkinAt: new Date(), status: 'CHECKED_IN' } });
  }
  if (gps?.lat != null && gps?.lng != null) {
    await prisma.activityLog.create({
      data: {
        entity: 'work_order',
        entityId: id,
        action: 'checkin_gps',
        actor: by,
        meta: { lat: gps.lat, lng: gps.lng } as Prisma.InputJsonValue,
      },
    });
  }
  return { work_order: await prisma.workOrder.findUniqueOrThrow({ where: { id } }), already: false };
}

/** A tap on a checklist step. Auto-only keys are refused. */
export async function setStep(id: string, key: string, by: string | null) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo?.systemId) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);
  if (AUTO_ONLY.has(key)) {
    throw new LifecycleError(403, 'AUTO_ONLY', `${key} is set by the machine, not by the crew`);
  }
  await applyChecklist(wo.systemId, { key, state: 'DONE', by });
  return { ok: true };
}

/** A camera prompt's result. Photos live on the work order (01 §work_orders). */
export async function addPhoto(
  id: string,
  photo: { stage_key: string; file_key: string; gps?: { lat: number; lng: number }; at?: string },
) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);
  const photos = (wo.photos as unknown[]) ?? [];
  // Idempotent: the same file_key never lands twice on a replayed queue.
  if (photos.some((p) => (p as { file_key?: string }).file_key === photo.file_key)) {
    return { photos, already: true };
  }
  const next = [...photos, { ...photo, at: photo.at ?? new Date().toISOString() }];
  await prisma.workOrder.update({ where: { id }, data: { photos: next as Prisma.InputJsonValue } });
  return { photos: next, already: false };
}

/**
 * Barcode serial capture — writes equipment rows and looks up each serial's
 * attestation. Serials already reserved for this system (ALLOCATED at S05) are
 * flipped to INSTALLED rather than duplicated.
 */
export async function captureSerials(
  id: string,
  serials: Array<{ serial: string; kind?: string; sku?: string }>,
  by: string | null,
) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo?.systemId) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);

  const results = [];
  for (const s of serials) {
    const existing = await prisma.equipment.findUnique({ where: { serial: s.serial } });
    if (existing) {
      if (existing.systemId && existing.systemId !== wo.systemId) {
        results.push({ serial: s.serial, result: 'rejected', detail: 'already installed on another system' });
        continue;
      }
      if (existing.status === 'INSTALLED') {
        results.push({ serial: s.serial, result: 'already', detail: 'already scanned' });
        continue;
      }
      await prisma.equipment.update({
        where: { id: existing.id },
        data: { systemId: wo.systemId, status: 'INSTALLED', installedAt: new Date() },
      });
      results.push({
        serial: s.serial,
        result: 'installed',
        detail: existing.attestationDocId ? 'attestation on file' : 'attestation pending',
      });
    } else {
      const created = await prisma.equipment.create({
        data: {
          systemId: wo.systemId,
          serial: s.serial,
          kind: (s.kind as never) ?? 'BATTERY',
          sku: s.sku,
          status: 'INSTALLED',
          installedAt: new Date(),
        },
      });
      results.push({ serial: created.serial, result: 'created', detail: 'attestation pending' });
    }
  }

  await prisma.activityLog.create({
    data: {
      entity: 'system',
      entityId: wo.systemId,
      action: 'serials_scanned',
      actor: by,
      meta: { work_order_id: id, results } as Prisma.InputJsonValue,
    },
  });
  return { results };
}

/** Enlighten activation confirm — captures X3 and closes its checklist step. */
export async function confirmActivation(
  id: string,
  input: { enlighten_site_id?: string; grid_profile?: string; fw?: string },
  by: string | null,
) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo?.systemId) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);

  await prisma.system.update({
    where: { id: wo.systemId },
    data: {
      ...(input.enlighten_site_id ? { enlightenSiteId: input.enlighten_site_id } : {}),
      ...(input.grid_profile ? { gridProfile: input.grid_profile } : {}),
      ...(input.fw ? { fwVersion: input.fw } : {}),
    },
  });
  await prisma.activityLog.create({
    data: {
      entity: 'system',
      entityId: wo.systemId,
      action: 'enlighten_activated',
      actor: by,
      meta: { work_order_id: id, ...input } as Prisma.InputJsonValue,
    },
  });
  return { ok: true };
}

/** Resident walkthrough signature. */
export async function captureSignature(
  id: string,
  input: { name: string; signature_key?: string },
  by: string | null,
) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo?.systemId) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);

  const checklist = ((wo.checklist as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  await prisma.workOrder.update({
    where: { id },
    data: {
      checklist: {
        ...checklist,
        walkthrough_signature: { name: input.name, key: input.signature_key ?? null, at: new Date().toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.activityLog.create({
    data: {
      entity: 'work_order',
      entityId: id,
      action: 'walkthrough_signed',
      actor: by,
      meta: { name: input.name } as Prisma.InputJsonValue,
    },
  });
  return { ok: true };
}

/**
 * Check out. This is where `installer_of_record` is stamped (L6), so it refuses
 * to run before check-in — a work order that was never started cannot have
 * produced an installer of record.
 */
export async function checkOut(id: string, by: string | null) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo) throw new LifecycleError(404, 'WORK_ORDER_NOT_FOUND', `No work order ${id}`);
  if (!wo.checkinAt) throw new LifecycleError(409, 'NOT_CHECKED_IN', 'Check in before checking out');
  if (wo.checkoutAt) return { work_order: wo, already: true }; // idempotent replay
  if (!wo.systemId) {
    const updated = await prisma.workOrder.update({
      where: { id },
      data: { checkoutAt: new Date(), status: 'COMPLETE' },
    });
    return { work_order: updated, already: false };
  }

  await onWorkOrderCheckout(wo.systemId, id, { by });
  const system = await prisma.system.findUniqueOrThrow({ where: { id: wo.systemId } });
  return {
    work_order: await prisma.workOrder.findUniqueOrThrow({ where: { id } }),
    installer_of_record: system.installerOfRecord,
    already: false,
  };
}

// ==== offline sync ==========================================================

export type FieldOp =
  | { id: string; op: 'checkin'; gps?: { lat: number; lng: number } }
  | { id: string; op: 'step'; key: string }
  | { id: string; op: 'photo'; photo: { stage_key: string; file_key: string; gps?: { lat: number; lng: number }; at?: string } }
  | { id: string; op: 'serials'; serials: Array<{ serial: string; kind?: string; sku?: string }> }
  | { id: string; op: 'activation'; enlighten_site_id?: string; grid_profile?: string; fw?: string }
  | { id: string; op: 'signature'; name: string; signature_key?: string }
  | { id: string; op: 'checkout' };

/**
 * Replay a queue captured offline, in order. Each op reports its own outcome so
 * a phone that lost signal mid-day can reconcile precisely, and every op is
 * idempotent so a partially-landed queue can be replayed whole.
 */
export async function syncOps(workOrderId: string, ops: FieldOp[], by: string | null) {
  const results: Array<{ id: string; op: string; result: 'applied' | 'skipped' | 'failed'; detail?: string }> = [];

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'checkin': {
          const r = await checkIn(workOrderId, op.gps, by);
          results.push({ id: op.id, op: op.op, result: r.already ? 'skipped' : 'applied', detail: r.already ? 'already checked in' : undefined });
          break;
        }
        case 'step':
          await setStep(workOrderId, op.key, by);
          results.push({ id: op.id, op: op.op, result: 'applied', detail: op.key });
          break;
        case 'photo': {
          const r = await addPhoto(workOrderId, op.photo);
          results.push({ id: op.id, op: op.op, result: r.already ? 'skipped' : 'applied' });
          break;
        }
        case 'serials': {
          const r = await captureSerials(workOrderId, op.serials, by);
          results.push({ id: op.id, op: op.op, result: 'applied', detail: r.results.map((x) => `${x.serial}:${x.result}`).join(' ') });
          break;
        }
        case 'activation':
          await confirmActivation(workOrderId, op, by);
          results.push({ id: op.id, op: op.op, result: 'applied' });
          break;
        case 'signature':
          await captureSignature(workOrderId, op, by);
          results.push({ id: op.id, op: op.op, result: 'applied' });
          break;
        case 'checkout': {
          const r = await checkOut(workOrderId, by);
          results.push({ id: op.id, op: op.op, result: r.already ? 'skipped' : 'applied' });
          break;
        }
      }
    } catch (err) {
      // One bad op must not strand the rest of the day's queue.
      const detail = err instanceof LifecycleError ? err.message : err instanceof Error ? err.message : 'failed';
      results.push({ id: op.id, op: op.op, result: 'failed', detail });
    }
  }

  return { applied: results.filter((r) => r.result === 'applied').length, results };
}
