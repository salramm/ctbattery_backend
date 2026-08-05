/**
 * Rate-tariff queries + shaping for the C&I engine's TariffTable / AnalysisForm.
 * Rate structures are nested JSON; helpers extract representative demand and
 * TOU-spread figures (best-effort heuristics, not a full rate engine).
 */
import type { RateTariff } from '@prisma/client';
import prisma from '../config/database';

/** Recursively collect all numeric `rate` (+ `adj`) values from a rate structure. */
function collectRates(structure: unknown): number[] {
  const rates: number[] = [];
  const walk = (node: unknown) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.rate === 'number') {
        rates.push(obj.rate + (typeof obj.adj === 'number' ? obj.adj : 0));
      }
      Object.values(obj).forEach(walk);
    }
  };
  walk(structure);
  return rates;
}

/** Representative demand charge ($/kW): max rate across flat + demand structures. */
export function effectiveDemandCharge(t: RateTariff): number | null {
  const rates = [
    ...collectRates(t.flatDemandStructure),
    ...collectRates(t.demandRateStructure),
  ];
  if (rates.length === 0) return null;
  return Math.round(Math.max(...rates) * 100) / 100;
}

/** TOU spread ($/kWh): max-min across energy rate tiers. */
export function touSpread(t: RateTariff): number {
  const rates = collectRates(t.energyRateStructure);
  if (rates.length < 2) return 0;
  return Math.round((Math.max(...rates) - Math.min(...rates)) * 10000) / 10000;
}

/** TariffTable shape (snake_case + computed helper fields). */
export function shapeTariff(t: RateTariff) {
  return {
    id: t.id,
    label: t.label,
    rate_name: t.rateName,
    sector: t.sector,
    service_type: t.serviceType,
    flat_demand_structure: t.flatDemandStructure,
    demand_ratchet_percentage: t.demandRatchetPercentage,
    energy_rate_structure: t.energyRateStructure,
    start_date: t.startDate,
    source_url: t.sourceUrl,
    _effective_demand_charge: effectiveDemandCharge(t),
    _tou_spread: touSpread(t),
  };
}

export async function listTariffs(
  utilityName: string | undefined,
  page: number,
  limit: number,
): Promise<{ rows: ReturnType<typeof shapeTariff>[]; total: number }> {
  const where = utilityName
    ? { utilityName: { contains: utilityName, mode: 'insensitive' as const } }
    : {};
  const [rows, total] = await Promise.all([
    prisma.rateTariff.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { id: 'asc' },
    }),
    prisma.rateTariff.count({ where }),
  ]);
  return { rows: rows.map(shapeTariff), total };
}

/** Demand/TOU/ratchet defaults for AnalysisForm, derived from a utility's tariffs. */
export async function getTariffDefaults(utilityName: string): Promise<{
  defaultDemandCharge: number;
  defaultTouSpread: number;
  defaultRatchet: number;
  sampleTariffs: ReturnType<typeof shapeTariff>[];
}> {
  const rows = await prisma.rateTariff.findMany({
    where: { utilityName: { contains: utilityName, mode: 'insensitive' } },
    take: 50,
    orderBy: { id: 'asc' },
  });

  const demandCharges = rows
    .map(effectiveDemandCharge)
    .filter((n): n is number => n != null && n > 0);
  const spreads = rows.map(touSpread).filter((n) => n > 0);
  const ratchets = rows
    .map((t) => t.demandRatchetPercentage)
    .filter((n): n is number => n != null && n > 0);

  const avg = (arr: number[], fallback: number) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : fallback;

  return {
    defaultDemandCharge: avg(demandCharges, 15),
    defaultTouSpread: avg(spreads, 0),
    defaultRatchet: ratchets.length ? Math.max(...ratchets) : 80,
    sampleTariffs: rows.slice(0, 25).map(shapeTariff),
  };
}
