import { z } from 'zod';

export const analyzeSchema = z.object({
  body: z.object({
    peak_demand_kw: z.number().positive().max(1_000_000),
    monthly_bill: z.number().nonnegative().max(100_000_000),
    facility_type: z.string().max(60),
    demand_charge_per_kw: z.number().nonnegative().max(1000),
    tou_spread_per_kwh: z.number().nonnegative().max(10),
    dr_revenue_per_kw_year: z.number().nonnegative().max(10_000),
    incentive_per_kwh: z.number().nonnegative().max(10_000),
    ratchet_percentage: z.number().min(0).max(100),
    utility_name: z.string().max(255).optional(),
  }),
});
