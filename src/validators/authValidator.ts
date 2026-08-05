import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    idToken: z.string().min(10, 'A Firebase ID token is required'),
  }),
});
