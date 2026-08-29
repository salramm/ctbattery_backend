/**
 * The lifecycle engine. One advance function and one gate validator drive every
 * caller: the Advance button, the kanban drag, document-date writes, and the
 * pollers/field app all funnel through `advance` / `runAutoChain`. Every mutation
 * is transactional and writes `activity_log`; the append-only `stage_history`
 * unique guard makes automation retries idempotent no-ops (02 §Endpoints).
 *
 * No stage logic lives outside lib/lifecycle. Routes are thin wrappers.
 */
import type { Prisma, System, ChecklistState, TerminalState, HistoryVia, Flag } from '@prisma/client';
import prisma from '../../config/database';
import { LifecycleError, GateError } from './errors';
import { evaluateGate } from './gates';
import { onEnter } from './effects';
import { nextTransition, shortCode } from './transitions';
import { notify } from './notifications';
import { assertNotHeld } from './holds';

type Tx = Prisma.TransactionClient;

// ==== helpers ================================================================

async function loadSystem(tx: Tx, id: string): Promise<System> {
  const system = await tx.system.findUnique({ where: { id } });
  if (!system) throw new LifecycleError(404, 'SYSTEM_NOT_FOUND', `No system ${id}`);
  return system;
}

function shapeHistory(h: { fromStage: string | null; toStage: string; at: Date; by: string | null; via: string }) {
  return { from: h.fromStage, to: h.toStage, at: h.at, by: h.by, via: h.via };
}

async function logActivity(tx: Tx, systemId: string, action: string, actor: string | null, meta: Prisma.InputJsonValue) {
  await tx.activityLog.create({ data: { entity: 'system', entityId: systemId, action, actor, meta } });
}

// ==== the single advance primitive ===========================================

interface AdvanceOnceResult {
  system: System;
  history: { fromStage: string | null; toStage: string; at: Date; by: string | null; via: string };
  skipped: boolean;
}

/**
 * Execute exactly one forward step (gate already decided by the caller). Writes
 * stage_history under its unique guard first: if the row already exists this is a
 * duplicate fire and we return without any side effect (idempotent).
 */
async function advanceOnce(tx: Tx, system: System, via: HistoryVia, by: string | null): Promise<AdvanceOnceResult> {
  const t = nextTransition(system.stage);
  if (!t) throw new LifecycleError(409, 'NO_FORWARD', `${shortCode(system.stage)} has no forward stage`);
  const from = system.stage;
  const to = t.to;

  const existing = await tx.stageHistory.findUnique({
    where: { systemId_fromStage_toStage: { systemId: system.id, fromStage: from, toStage: to } },
  });
  if (existing) return { system, history: existing, skipped: true };

  const history = await tx.stageHistory.create({
    data: { systemId: system.id, fromStage: from, toStage: to, by: by ?? 'system', via },
  });

  // On-enter effects see the post-advance record; they may return extra column
  // writes we fold into the single stage update to keep it one row write.
  const moved: System = { ...system, stage: to };
  const extra = await onEnter(tx, moved, to);
  const updated = await tx.system.update({ where: { id: system.id }, data: { stage: to, ...extra } });

  await logActivity(tx, system.id, 'advance', by, { from, to, via } as Prisma.InputJsonValue);
  return { system: updated, history, skipped: false };
}

/**
 * Advance through every AUTO transition whose gate is now satisfied. This is the
 * automation runner: because each AUTO gate equals its trigger predicate, "keep
 * stepping while the next transition is AUTO and its gate passes" reproduces the
 * whole chain — including S08→S09→OPERATING in one pass. Stops at MANUAL steps,
 * blocks, terminals, and unmet gates.
 */
async function runAutoChain(tx: Tx, systemId: string, by: string | null): Promise<System> {
  let system = await loadSystem(tx, systemId);
  for (;;) {
    if (system.terminalState || system.blockedCode) break;
    const t = nextTransition(system.stage);
    if (!t || t.driver !== 'AUTO') break;
    const gate = await evaluateGate(tx, system);
    if (gate.unmet.length) break;
    const res = await advanceOnce(tx, system, 'AUTO', by);
    if (res.skipped) break;
    system = res.system;
  }
  return system;
}

// ==== public: advance (MANUAL / OVERRIDE) ====================================

export interface AdvanceOpts {
  via: 'MANUAL' | 'OVERRIDE';
  by?: string | null;
  reason?: string;
}

export async function advance(systemId: string, opts: AdvanceOpts) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    if (system.terminalState) {
      throw new LifecycleError(409, 'TERMINAL', `System is ${system.terminalState}; stage is frozen`);
    }
    if (system.blockedCode) {
      throw new LifecycleError(409, 'BLOCKED', `REFUSED — ${system.blockedCode} must clear before this system can advance`);
    }
    const t = nextTransition(system.stage);
    if (!t) throw new LifecycleError(409, 'NO_FORWARD', `${shortCode(system.stage)} has no forward stage`);

    if (opts.via === 'OVERRIDE') {
      if (!opts.reason) throw new LifecycleError(400, 'REASON_REQUIRED', 'Override requires a reason');
    } else {
      // MANUAL only advances MANUAL transitions; AUTO steps wait for their trigger.
      if (t.driver !== 'MANUAL') {
        throw new LifecycleError(
          409,
          'AUTO_TRANSITION',
          `${shortCode(t.from)} → ${shortCode(t.to)} is automatic — ${t.fires}`,
        );
      }
      const gate = await evaluateGate(tx, system);
      if (gate.unmet.length) throw new GateError(gate.gate, gate.unmet);
    }

    const first = await advanceOnce(tx, system, opts.via, opts.by ?? null);
    const finalSystem = await runAutoChain(tx, systemId, 'system');
    return { system: finalSystem, history: shapeHistory(first.history) };
  });
}

// ==== AUTO trigger entry points (pollers / field app / docs) =================

/** S01→S02 on snapshot; non-EDC territory terminalizes DISQUALIFIED instead (stage preserved). */
export async function onSnapshotWritten(systemId: string, opts: { edcServed?: boolean; by?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    if (!system.currentSnapshotId) {
      throw new LifecycleError(422, 'NO_SNAPSHOT', 'current_snapshot_id must be set before firing S01→S02');
    }
    if (opts.edcServed === false) {
      const term = await tx.system.update({
        where: { id: systemId },
        data: { terminalState: 'DISQUALIFIED', terminalReason: 'Address not in an EDC target territory', terminalAt: new Date() },
      });
      await logActivity(tx, systemId, 'terminal', opts.by ?? 'system', { state: 'DISQUALIFIED', reason: 'non-EDC' });
      return term;
    }
    return runAutoChain(tx, systemId, opts.by ?? 'system');
  });
}

/** ROF letter logged → write rof_date (+ enrollment mirror), mark item, AUTO S04→S05 chain. */
export async function onRofLogged(systemId: string, opts: { date?: Date; by?: string | null } = {}) {
  const date = opts.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.system.update({ where: { id: systemId }, data: { rofDate: date } });
    await tx.enrollment.updateMany({ where: { systemId }, data: { rofDate: date } });
    await tx.checklistItem.updateMany({
      where: { systemId, key: 'rof_letter', state: { not: 'DONE' } },
      data: { state: 'DONE', doneAt: new Date(), doneBy: opts.by ?? 'system' },
    });
    await logActivity(tx, systemId, 'rof_logged', opts.by ?? 'system', { rof_date: date.toISOString() });
    return runAutoChain(tx, systemId, 'system');
  });
}

/** COF letter logged → write cof_date, mark item, AUTO S08→S09→OPERATING chain. */
export async function onCofLogged(systemId: string, opts: { date?: Date; by?: string | null } = {}) {
  const date = opts.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.system.update({ where: { id: systemId }, data: { cofDate: date } });
    await tx.enrollment.updateMany({ where: { systemId }, data: { cofDate: date } });
    await tx.checklistItem.updateMany({
      where: { systemId, key: 'cof_letter', state: { not: 'DONE' } },
      data: { state: 'DONE', doneAt: new Date(), doneBy: opts.by ?? 'system' },
    });
    await logActivity(tx, systemId, 'cof_logged', opts.by ?? 'system', { cof_date: date.toISOString() });
    return runAutoChain(tx, systemId, 'system');
  });
}

/** INSTALL work-order check-in → AUTO S06→S07. */
export async function onWorkOrderCheckin(systemId: string, workOrderId: string, opts: { by?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.workOrder.update({ where: { id: workOrderId }, data: { checkinAt: new Date(), status: 'CHECKED_IN' } });
    await logActivity(tx, systemId, 'wo_checkin', opts.by ?? 'system', { work_order_id: workOrderId });
    return runAutoChain(tx, systemId, 'system');
  });
}

/**
 * Work-order check-out (L6): snapshot installer_of_record onto the system. Does
 * not itself advance — the poller's telemetry confirm closes S07.
 */
export async function onWorkOrderCheckout(systemId: string, workOrderId: string, opts: { by?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    const wo = await tx.workOrder.update({
      where: { id: workOrderId },
      data: { checkoutAt: new Date(), status: 'COMPLETE' },
      include: { crew: { include: { installer: true } } },
    });
    const members = (wo.crew?.members as Array<{ name?: string }> | null) ?? [];
    const installerOfRecord = {
      installer_org: wo.crew?.installer?.orgName ?? null,
      crew_label: wo.crew?.label ?? null,
      lead_name: members[0]?.name ?? null,
      install_date: (wo.date ?? wo.checkinAt ?? new Date()).toISOString(),
      work_order_id: wo.id,
    };
    await tx.system.update({
      where: { id: systemId },
      data: {
        installerOfRecord: installerOfRecord as Prisma.InputJsonValue,
        installDate: wo.date ?? wo.checkinAt ?? new Date(),
      },
    });
    await logActivity(tx, systemId, 'wo_checkout', opts.by ?? 'system', { work_order_id: workOrderId });
    return runAutoChain(tx, systemId, 'system');
  });
}

/** Poller confirms SoC reporting → mark telemetry_confirmed, AUTO S07→S08 (with field checklist 100%). */
export async function onTelemetryConfirmed(systemId: string, _opts: { by?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.checklistItem.updateMany({
      where: { systemId, key: 'telemetry_confirmed', state: { not: 'DONE' } },
      data: { state: 'DONE', doneAt: new Date(), doneBy: 'system' },
    });
    await logActivity(tx, systemId, 'telemetry_confirmed', 'system', {});
    return runAutoChain(tx, systemId, 'system');
  });
}

/** Poller sees the system in DERMS → mark derms_visible (+ capture X4 if provided). */
export async function onDermsVisible(systemId: string, opts: { dermsId?: string } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.checklistItem.updateMany({
      where: { systemId, key: 'derms_visible', state: { not: 'DONE' } },
      data: { state: 'DONE', doneAt: new Date(), doneBy: 'system' },
    });
    if (opts.dermsId) await tx.system.update({ where: { id: systemId }, data: { dermsId: opts.dermsId } });
    await logActivity(tx, systemId, 'derms_visible', 'system', { derms_id: opts.dermsId ?? null });
    return runAutoChain(tx, systemId, 'system');
  });
}

// ==== checklist PATCH ========================================================

const AUTO_ONLY_KEYS = new Set(['telemetry_confirmed', 'derms_visible']);

export interface ChecklistPatch {
  key: string;
  state: ChecklistState;
  docId?: string | null;
  by?: string | null;
}

export async function applyChecklist(systemId: string, patch: ChecklistPatch) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    const item = await tx.checklistItem.findFirst({ where: { systemId, stage: system.stage, key: patch.key } });
    if (!item) throw new LifecycleError(404, 'CHECKLIST_ITEM_NOT_FOUND', `No ${patch.key} item at ${shortCode(system.stage)}`);
    if (AUTO_ONLY_KEYS.has(patch.key)) {
      throw new LifecycleError(403, 'AUTO_ONLY', `${patch.key} is set by the machine, not by hand`);
    }
    if (item.state === 'NA') {
      throw new LifecycleError(409, 'ITEM_NOT_APPLICABLE', `${patch.key} is N/A for this system`);
    }

    const done = patch.state === 'DONE';
    // Held items (cgb_app_submitted behind the ESA cancellation window) refuse a
    // DONE write until their clock closes — 02 §Transitions S03→S04.
    if (done) await assertNotHeld(tx, systemId, patch.key);

    const updated = await tx.checklistItem.update({
      where: { id: item.id },
      data: {
        state: patch.state,
        docId: patch.docId ?? item.docId,
        doneAt: done ? new Date() : null,
        doneBy: done ? patch.by ?? 'system' : null,
      },
    });

    // Per-item data effects that a DONE write implies.
    if (done && patch.key === 'connection_method_confirmed' && !system.connectionMethod) {
      await tx.system.update({ where: { id: systemId }, data: { connectionMethod: 'M1' } });
    }

    await logActivity(tx, systemId, 'checklist', patch.by ?? 'system', { key: patch.key, state: patch.state });
    const finalSystem = await runAutoChain(tx, systemId, 'system');
    return { item: updated, system: finalSystem };
  });
}

// ==== documents ==============================================================

export interface LogDocumentInput {
  systemId: string;
  type: Prisma.DocumentCreateInput['type'];
  title?: string;
  fileKey?: string;
  envelopeId?: string;
  by?: string | null;
  date?: Date;
}

/**
 * Record a document. ROF/COF letter types write their date and fire the matching
 * AUTO chain (02 §Endpoints). All in one transaction so the doc and the advance
 * commit together.
 */
export async function logDocument(input: LogDocumentInput) {
  return prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        systemId: input.systemId,
        type: input.type,
        title: input.title,
        fileKey: input.fileKey,
        envelopeId: input.envelopeId,
        status: input.fileKey ? 'DRAFT' : 'DRAFT',
        uploadedBy: input.by ?? undefined,
      },
    });
    await logActivity(tx, input.systemId, 'document', input.by ?? 'system', { type: input.type, doc_id: document.id });

    if (input.type === 'ROF_LETTER' || input.type === 'COF_LETTER') {
      const date = input.date ?? new Date();
      const key = input.type === 'ROF_LETTER' ? 'rof_letter' : 'cof_letter';
      const dateField = input.type === 'ROF_LETTER' ? { rofDate: date } : { cofDate: date };
      await tx.system.update({ where: { id: input.systemId }, data: dateField });
      await tx.enrollment.updateMany({ where: { systemId: input.systemId }, data: dateField });
      await tx.checklistItem.updateMany({
        where: { systemId: input.systemId, key, state: { not: 'DONE' } },
        data: { state: 'DONE', doneAt: new Date(), doneBy: input.by ?? 'system', docId: document.id },
      });
      const system = await runAutoChain(tx, input.systemId, 'system');
      return { document, system };
    }

    const system = await loadSystem(tx, input.systemId);
    return { document, system };
  });
}

// ==== block / unblock ========================================================

export async function block(systemId: string, code: string, note: string | undefined, by: string | null) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    const bc = await tx.blockedCode.findUnique({ where: { code } });
    if (!bc) throw new LifecycleError(404, 'BLOCK_CODE_NOT_FOUND', `Unknown block code ${code}`);
    if (bc.stage !== system.stage) {
      throw new LifecycleError(409, 'BLOCK_CODE_WRONG_STAGE', `${code} belongs to ${shortCode(bc.stage)}, not ${shortCode(system.stage)}`);
    }
    const updated = await tx.system.update({
      where: { id: systemId },
      data: { blockedCode: code, blockedAt: new Date(), blockedNote: note ?? null },
    });
    await logActivity(tx, systemId, 'block', by, { code, note: note ?? null });
    return updated;
  });
}

export async function unblock(systemId: string, by: string | null) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    const prior = system.blockedCode;
    const updated = await tx.system.update({
      where: { id: systemId },
      data: { blockedCode: null, blockedAt: null, blockedNote: null },
    });
    await logActivity(tx, systemId, 'unblock', by, { cleared: prior });
    return updated;
  });
}

// ==== terminal ===============================================================

function monthsRemaining(end: Date, from: Date): number {
  return Math.max(0, (end.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.4375));
}

export interface TerminalInput {
  state: TerminalState;
  reason: string;
  acknowledgeClawback?: boolean;
  by?: string | null;
}

/**
 * Terminalize (admin). Stage is preserved (L2). REMOVED inside the ITC recapture
 * window returns 409 with the computed clawback unless acknowledged (02 §Terminal).
 */
export async function terminal(systemId: string, input: TerminalInput) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);

    if (input.state === 'REMOVED' && system.recaptureEnd && new Date() < system.recaptureEnd) {
      const claim = await tx.itcClaim.findUnique({ where: { systemId } });
      const credit = claim?.creditAmt ? Number(claim.creditAmt) : 0;
      const clawback = Math.round(credit * (monthsRemaining(system.recaptureEnd, new Date()) / 60) * 100) / 100;
      if (!input.acknowledgeClawback) {
        throw new LifecycleError(409, 'RECAPTURE_WINDOW', 'REMOVED inside the ITC recapture window', {
          clawback_amount: clawback,
          recapture_end: system.recaptureEnd,
          acknowledge_required: true,
        });
      }
      await logActivity(tx, systemId, 'clawback_ack', input.by ?? null, { clawback_amount: clawback });
    }

    const updated = await tx.system.update({
      where: { id: systemId },
      data: { terminalState: input.state, terminalReason: input.reason, terminalAt: new Date() },
    });
    await logActivity(tx, systemId, 'terminal', input.by ?? null, { state: input.state, reason: input.reason });
    return updated;
  });
}

// ==== turnover ===============================================================

export async function openTurnover(systemId: string, by: string | null) {
  return prisma.$transaction(async (tx) => {
    const system = await loadSystem(tx, systemId);
    const openedAt = new Date();
    const slaDue = new Date(openedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const turnover = await tx.turnoverCase.create({
      data: {
        systemId,
        openedAt,
        slaDue,
        tasks: { new_esa: null, appendix_e: null, edc_update: false, derms_verify: false } as Prisma.InputJsonValue,
      },
    });
    const flags: Flag[] = system.flags.includes('TURNOVER') ? system.flags : [...system.flags, 'TURNOVER'];
    const updated = await tx.system.update({ where: { id: systemId }, data: { flags } });
    notify.reminder(systemId, 'turnover_sla');
    await logActivity(tx, systemId, 'turnover_open', by, { turnover_id: turnover.id, sla_due: slaDue.toISOString() });
    return { turnover, system: updated };
  });
}
