/**
 * External side-effect seam (02 §On-enter). SMS, DocuSign envelope sends, the
 * self-inspection PDF compile, and poller "watches" all funnel through here so
 * the state machine never imports a vendor SDK directly. Log-only for now — a
 * real implementation swaps the body of these functions, not their callers.
 */

type TaskKind =
  | 'sms'
  | 'docusign_send'
  | 'self_inspection_pdf'
  | 'clock_watch'
  | 'poller_arm'
  | 'batch_suggest'
  | 'reminder';

export interface NotifyPayload {
  systemId: string;
  detail?: Record<string, unknown>;
}

/** Enqueue an external side effect. Stubbed: writes a structured console line. */
export function enqueue(kind: TaskKind, payload: NotifyPayload): void {
  console.log(`[lifecycle:notify] ${kind} system=${payload.systemId}`, payload.detail ?? {});
}

export const notify = {
  sms: (systemId: string, template: string) => enqueue('sms', { systemId, detail: { template } }),
  docusignSend: (systemId: string, envelopes: string[]) =>
    enqueue('docusign_send', { systemId, detail: { envelopes } }),
  selfInspectionPdf: (systemId: string) => enqueue('self_inspection_pdf', { systemId }),
  clockWatch: (systemId: string, clock: string) => enqueue('clock_watch', { systemId, detail: { clock } }),
  pollerArm: (systemId: string, watch: string) => enqueue('poller_arm', { systemId, detail: { watch } }),
  batchSuggest: (systemId: string) => enqueue('batch_suggest', { systemId }),
  reminder: (systemId: string, which: string) => enqueue('reminder', { systemId, detail: { which } }),
};
