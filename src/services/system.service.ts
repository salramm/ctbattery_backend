/**
 * System page — the canonical record (03 §System page).
 *
 * One call returns the whole page: the header block (stage ribbon or, when
 * Operating, health chip + term progress), the blocked banner, the
 * server-computed Next action, key dates, the five external IDs, and every tab.
 *
 * "Next action" is computed here, not in the client: it is the first unmet gate
 * item, or the active clock if the gate is clear. The page renders the answer.
 */
import type { Stage } from '@prisma/client';
import prisma from '../config/database';
import {
  LifecycleError,
  STAGE_ORDER,
  evaluateGate,
  evaluateClocks,
  nextTransition,
  shortCode,
  stageLabel,
  daysBetween,
} from '../lib/lifecycle';

const LIVE: Stage[] = ['S09_LIVE', 'OPERATING'];

export async function getSystem(id: string, now = new Date()) {
  const system = await prisma.system.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, town: true, account: { select: { id: true, name: true, dealState: true } } } },
      resident: true,
      blockedCodeRef: true,
      enrollments: { orderBy: { createdAt: 'desc' } },
      checklistItems: { orderBy: [{ stage: 'asc' }, { key: 'asc' }] },
      documents: { orderBy: { createdAt: 'desc' } },
      equipment: { orderBy: { serial: 'asc' } },
      stageHistory: { orderBy: { at: 'asc' } },
      itcClaim: { include: { basisLines: true, cohort: true } },
      ledgerEntries: { include: { season: true }, orderBy: { expectedDate: 'desc' } },
      tickets: { orderBy: { createdAt: 'desc' } },
      alerts: { where: { clearedAt: null }, include: { rule: true } },
      turnoverCases: { orderBy: { openedAt: 'desc' } },
      workOrders: { include: { crew: { include: { installer: true } } }, orderBy: { date: 'desc' } },
      qualSnapshots: { orderBy: { version: 'desc' } },
      events: { orderBy: { date: 'desc' }, take: 20 },
    },
  });
  if (!system) throw new LifecycleError(404, 'SYSTEM_NOT_FOUND', `No system ${id}`);

  const gate = await evaluateGate(prisma, system);
  const clocks = await evaluateClocks(system.id, prisma, now);
  const transition = nextTransition(system.stage);
  const isLive = LIVE.includes(system.stage);

  // Days in stage from stage_history — never a column (00, 01 §Derived).
  const entered = [...system.stageHistory].reverse().find((h) => h.toStage === system.stage)?.at ?? null;

  // 03: "Next action — server-computed: first unmet gate item or active clock".
  const nextAction = gate.unmet.length
    ? { kind: 'gate' as const, label: gate.unmet[0].label, owner_role: gate.unmet[0].owner_role, key: gate.unmet[0].key }
    : clocks.length
      ? { kind: 'clock' as const, label: `${clocks[0].clock.replace(/_/g, ' ')} — ${clocks[0].daysToDue != null && clocks[0].daysToDue < 0 ? `${Math.abs(clocks[0].daysToDue)}d overdue` : `${clocks[0].daysToDue}d left`}`, owner_role: null, key: clocks[0].clock }
      : transition
        ? { kind: 'advance' as const, label: `Ready to advance to ${shortCode(transition.to)} — ${transition.fires}`, owner_role: null, key: 'advance' }
        : { kind: 'none' as const, label: 'Operating — nothing outstanding', owner_role: null, key: 'none' };

  // Term progress: months into the 120-month performance term.
  const termMonths = system.cofDate ? Math.max(0, Math.floor(daysBetween(system.cofDate, now) / 30.4375)) : null;

  return {
    id: system.id,
    address: system.addressLine,
    unit_label: system.unitLabel,
    stage: system.stage,
    stage_code: shortCode(system.stage),
    stage_label: stageLabel(system.stage),
    stage_index: STAGE_ORDER.indexOf(system.stage),
    is_live: isLive,
    lens: isLive ? 'op' : 'pipe',
    health: system.health,
    flags: system.flags,
    tier: system.tier,
    grid_edge: system.gridEdge,
    days_in_stage: entered ? daysBetween(entered, now) : null,
    entered_stage_at: entered,

    resident: system.resident ? { name: system.resident.name, phone: system.resident.phone, email: system.resident.email } : null,
    property: system.property,

    blocked: system.blockedCode
      ? {
          code: system.blockedCode,
          label: system.blockedCodeRef?.label ?? null,
          note: system.blockedNote,
          at: system.blockedAt,
          age_days: system.blockedAt ? daysBetween(system.blockedAt, now) : null,
          today_after_days: system.blockedCodeRef?.todayAfterDays ?? null,
        }
      : null,
    terminal: system.terminalState
      ? { state: system.terminalState, reason: system.terminalReason, at: system.terminalAt }
      : null,

    next_action: nextAction,
    gate: { stage: gate.gate, unmet: gate.unmet },
    transition: transition ? { to: transition.to, driver: transition.driver, fires: transition.fires } : null,

    key_dates: {
      rof_date: system.rofDate,
      rof_deadline: system.rofDeadline,
      install_date: system.installDate,
      pis_date: system.pisDate,
      cof_date: system.cofDate,
      term_end: system.termEnd,
      warranty_end: system.warrantyEnd,
      recapture_end: system.recaptureEnd,
    },
    term_progress: termMonths == null ? null : { months_in: termMonths, months_total: 120 },

    /** The five external identities, X1–X5 (01 §systems). */
    external_ids: [
      { key: 'X1', label: 'CGB application #', value: system.cgbAppNo },
      { key: 'X2', label: 'EDC account # / IX app #', value: [system.edcAccountNo, system.ixAppNo].filter(Boolean).join(' · ') || null },
      { key: 'X3', label: 'Enlighten site / gateway', value: [system.enlightenSiteId, system.gatewaySn].filter(Boolean).join(' · ') || null },
      { key: 'X4', label: 'DERMS enrolment ID', value: system.dermsId },
      { key: 'X5', label: 'AHJ permit #', value: system.permitNo },
    ],

    clocks: clocks.map((c) => ({ clock: c.clock, level: c.level, due_at: c.dueAt, days_to_due: c.daysToDue, consequence: c.consequence })),

    // ---- tabs -------------------------------------------------------------
    overview: {
      snapshot: system.qualSnapshots[0]
        ? { version: system.qualSnapshots[0].version, tier: system.qualSnapshots[0].tier, itc_profile: system.qualSnapshots[0].itcProfile, revenue_projection: system.qualSnapshots[0].revenueProjection, run_at: system.qualSnapshots[0].runAt }
        : null,
      stage_history: system.stageHistory.map((h) => ({ from: h.fromStage, to: h.toStage, at: h.at, by: h.by, via: h.via })),
      last_event: system.events[0]
        ? { date: system.events[0].date, window: system.events[0].window, kw_delivered: system.events[0].kwDelivered, ratio: system.events[0].ratio }
        : null,
    },
    checklist: system.checklistItems
      .filter((c) => c.stage === system.stage)
      .map((c) => ({ key: c.key, label: c.label, state: c.state, required: c.required, owner_role: c.ownerRole, doc_id: c.docId, done_at: c.doneAt, done_by: c.doneBy })),
    documents: system.documents.map((d) => ({ id: d.id, type: d.type, title: d.title, status: d.status, envelope_id: d.envelopeId, signed_at: d.signedAt, created_at: d.createdAt })),
    equipment: system.equipment.map((e) => ({ id: e.id, serial: e.serial, kind: e.kind, sku: e.sku, dom: e.dom, status: e.status, fw: e.fw, attestation_doc_id: e.attestationDocId, replaced_by_id: e.replacedById, rma_no: e.rmaNo, installed_at: e.installedAt, removed_at: e.removedAt })),
    program: {
      enrollments: system.enrollments.map((e) => ({ id: e.id, program: e.program, app_no: e.appNo, rof_date: e.rofDate, cof_date: e.cofDate, tier: e.tier, status: e.status, deficiency_due: e.deficiencyDue })),
      locked_rates: system.lockedRates,
      connection_method: system.connectionMethod,
      grid_profile: system.gridProfile,
      fw_version: system.fwVersion,
    },
    service: {
      installer_of_record: system.installerOfRecord,
      warranty_end: system.warrantyEnd,
      tickets: system.tickets.map((t) => ({ id: t.id, category: t.category, severity: t.severity, state: t.state, resolution_code: t.resolutionCode, warranty_flag: t.warrantyFlag, created_at: t.createdAt })),
      open_alerts: system.alerts.map((a) => ({ id: a.id, rule_key: a.ruleKey, severity: a.severity, trigger: a.rule?.triggerDesc ?? null, opened_at: a.openedAt })),
      work_orders: system.workOrders.map((w) => ({ id: w.id, type: w.type, status: w.status, date: w.date, crew: w.crew ? { label: w.crew.label, installer: w.crew.installer.orgName } : null })),
      turnovers: system.turnoverCases.map((t) => ({ id: t.id, opened_at: t.openedAt, sla_due: t.slaDue, closed_at: t.closedAt, tasks: t.tasks })),
    },
    money: {
      ledger: system.ledgerEntries.map((l) => ({ id: l.id, type: l.type, season: l.season ? `${l.season.name} ${l.season.programYear}` : null, expected_amt: l.expectedAmt, expected_date: l.expectedDate, received_amt: l.receivedAmt, received_date: l.receivedDate, status: l.status })),
      claim: system.itcClaim
        ? {
            id: system.itcClaim.id,
            status: system.itcClaim.status,
            basis_amt: system.itcClaim.basisAmt,
            stack: system.itcClaim.stack,
            total_pct: system.itcClaim.totalPct,
            credit_amt: system.itcClaim.creditAmt,
            pis_date: system.itcClaim.pisDate,
            recapture_end: system.itcClaim.recaptureEnd,
            in_recapture: Boolean(system.itcClaim.recaptureEnd && now < system.itcClaim.recaptureEnd),
            cohort: system.itcClaim.cohort ? { label: system.itcClaim.cohort.label, status: system.itcClaim.cohort.status } : null,
            basis_lines: system.itcClaim.basisLines.map((b) => ({ source: b.source, amount: b.amount, doc_id: b.docId })),
          }
        : null,
    },
    performance: {
      events: system.events.map((e) => ({ date: e.date, window: e.window, kw_nominated: e.kwNominated, kw_delivered: e.kwDelivered, ratio: e.ratio, online: e.online })),
    },
  };
}
