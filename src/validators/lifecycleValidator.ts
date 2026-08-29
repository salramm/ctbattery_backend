/**
 * Zod schemas for the lifecycle mutation endpoints (02 §Endpoints). Every
 * mutation validates; the state machine never sees an unparsed payload.
 */
import { z } from 'zod';

const CHECKLIST_STATE = z.enum(['OPEN', 'NA', 'DONE']);

const DOC_TYPE = z.enum([
  'ESA',
  'TC',
  'PAYEE_DESIGNATION',
  'MASTER_AGMT',
  'PERMIT',
  'IX_APPROVAL',
  'SELF_INSPECTION',
  'ROF_LETTER',
  'COF_LETTER',
  'APPENDIX_E',
  'ATTESTATION',
  'PHOTO',
  'STATEMENT',
  'OTHER',
]);

const TERMINAL_STATE = z.enum(['DISQUALIFIED', 'WITHDRAWN', 'EXPIRED', 'REMOVED', 'TERM_COMPLETE']);

export const advanceSchema = z.object({
  body: z.object({
    via: z.enum(['MANUAL', 'OVERRIDE']).default('MANUAL'),
    reason: z.string().min(1).max(500).optional(),
  }),
});

export const blockSchema = z.object({
  body: z.object({
    code: z.string().min(1).max(40),
    note: z.string().max(1000).optional(),
  }),
});

export const unblockSchema = z.object({
  body: z.object({}).optional(),
});

export const terminalSchema = z.object({
  body: z.object({
    state: TERMINAL_STATE,
    reason: z.string().min(1).max(500),
    acknowledge_clawback: z.boolean().optional(),
  }),
});

export const checklistSchema = z.object({
  body: z.object({
    key: z.string().min(1).max(80),
    state: CHECKLIST_STATE,
    doc_id: z.string().max(64).optional(),
  }),
});

export const docsSchema = z.object({
  body: z.object({
    type: DOC_TYPE,
    title: z.string().max(300).optional(),
    // ISO date the letter is effective (ROF/COF); defaults to now on the server.
    date: z.string().datetime().optional(),
  }),
});

export const turnoverSchema = z.object({
  body: z.object({}).optional(),
});
