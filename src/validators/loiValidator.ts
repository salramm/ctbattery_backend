import { z } from 'zod';

export const createLoiSchema = z.object({
  body: z.object({
    siteOwnerName: z.string().min(1).max(200),
    propertyAddress: z.string().min(1).max(400),
    email: z.string().email().max(255),
    phone: z.string().max(40).optional(),
    batteryCount: z.enum(['one', 'two', 'three_plus']).optional(),
    rooftopSolar: z.enum(['yes', 'no', 'planned']).optional(),
    timeframe: z.enum(['asap', 'flexible']).optional(),
    reasons: z.array(z.string().max(40)).max(12).optional(),
    reasonOther: z.string().max(300).optional(),
    signedName: z.string().min(1).max(200),
    source: z.string().max(64).optional(),
  }),
});
