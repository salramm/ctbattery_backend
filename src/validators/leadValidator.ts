import { z } from 'zod';

export const createLeadSchema = z.object({
  body: z.object({
    email: z.string().email().max(255),
    firstName: z.string().max(120).optional(),
    lastName: z.string().max(120).optional(),
    cityOrZip: z.string().max(120).optional(),
    phone: z.string().max(40).optional(),
    tenure: z.string().max(40).optional(),
    source: z.string().max(64).optional(),
  }),
});
