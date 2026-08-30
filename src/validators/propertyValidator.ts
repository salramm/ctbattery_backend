/**
 * Zod schemas for the property batch surface (03 §Property page).
 */
import { z } from 'zod';

export const BATCH_ACTIONS = [
  'qualify_all',
  'generate_esas',
  'submit_cgb_apps',
  'build_install_week',
  'submit_completion_pkgs',
] as const;

export const batchSchema = z.object({
  body: z.object({
    action: z.enum(BATCH_ACTIONS),
    // Optional narrowing to specific units; omitted = every eligible unit.
    unit_ids: z.array(z.string().min(1)).max(500).optional(),
  }),
});
