/**
 * lib/lifecycle — the state machine. One gate validator + one advance function
 * used by every caller (routes, pollers, field app). No stage logic lives outside
 * this module (02 §, P2).
 */
export * from './transitions';
export * from './errors';
export { evaluateGate, evaluateGateWith, batchContext } from './gates';
export type { GateResult, GateContext } from './gates';
export { buildLifecycleMap } from './map';
export { assertNotHeld } from './holds';
export * from './dates';
export {
  evaluateClocks,
  evaluateSystemClocks,
  recordCrossings,
  sweepClocks,
  warnDate,
} from './clocks';
export type { ClockHit, ClockLevel } from './clocks';
export { computeHealth, recomputeHealth } from './health';
export {
  RULES,
  openAlert,
  clearAlert,
  verifyTicket,
  runVerifications,
  openTicketForAlert,
  evaluateEventRules,
} from './alerts';
export type { RuleSpec, OpenAlertResult } from './alerts';
export { transitionTicket, logRemoteAttempt, recordRma } from './tickets';
export type { TransitionOpts, RmaInput } from './tickets';
export {
  readTelemetry,
  readOne,
  hasCleanTelemetry,
  EXPECTED_SAMPLE_INTERVAL_HOURS,
  MIN_SAMPLES_FOR_COMMS,
} from './telemetry';
export type { TelemetryRead } from './telemetry';
export {
  advance,
  applyChecklist,
  logDocument,
  block,
  unblock,
  terminal,
  openTurnover,
  onSnapshotWritten,
  onRofLogged,
  onCofLogged,
  onWorkOrderCheckin,
  onWorkOrderCheckout,
  onTelemetryConfirmed,
  onDermsVisible,
} from './machine';
export type { AdvanceOpts, ChecklistPatch, LogDocumentInput, TerminalInput } from './machine';
