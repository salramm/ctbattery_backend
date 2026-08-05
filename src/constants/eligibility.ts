/**
 * Eligibility rules for the consumer apply flow. Ported from the original
 * client-side demo in apps/web/src/app/ct/apply/Workflow.tsx.
 */

/** CT distressed municipalities → PRIORITY program tier. */
export const DISTRESSED_MUNIS = [
  'hartford',
  'new haven',
  'bridgeport',
  'waterbury',
  'new britain',
  'meriden',
  'east hartford',
];

/** Substrings of HIFLD territory NAMEs that count as CT target utilities. */
export const CT_TARGET_UTILITY_MATCHERS = [
  'connecticut light and power',
  'united illuminating',
  'norwich',
];

/** The state we serve. */
export const SERVED_STATE = 'CT';
