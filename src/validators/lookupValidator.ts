import { z } from 'zod';

// Coordinates are optional: the C&I engine sends lat/lng (full territory
// resolution); the consumer apply flow sends address only (string-based
// eligibility). At least one of {coords, address} must be present.
export const lookupSchema = z.object({
  body: z
    .object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      address: z.string().max(400).optional(),
    })
    .refine((b) => (b.lat != null && b.lng != null) || !!b.address, {
      message: "Provide coordinates (lat & lng) or an address",
    })
    .refine((b) => (b.lat == null) === (b.lng == null), {
      message: "lat and lng must be provided together",
    }),
});
