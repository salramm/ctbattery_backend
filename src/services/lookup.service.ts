/**
 * Address/coordinate lookup: resolves the utility territory, joins enrichment,
 * derives eligibility, and assembles the union payload consumed by both the
 * consumer apply flow (eligibility) and the C&I engine cards (utility/enrichment
 * /incentives/tariff defaults).
 */
import { resolveTerritory } from './territory.service';
import { getEnrichmentByUtility, shapeEnrichment, shapeIncentives } from './enrichment.service';
import { getTariffDefaults } from './tariff.service';
import { geocodeOneline } from './geocode.service';
import { DISTRESSED_MUNIS, SERVED_STATE } from '../constants/eligibility';

export type EligibilityKind = 'STANDARD' | 'PRIORITY' | 'INELIGIBLE';

export interface LookupInput {
  lat?: number;
  lng?: number;
  address?: string;
}

function detectCity(address?: string | null): string | null {
  if (!address) return null;
  const lower = address.toLowerCase();
  const match = DISTRESSED_MUNIS.find((c) => lower.includes(c));
  return match ? match.replace(/\b\w/g, (ch) => ch.toUpperCase()) : null;
}

/** Fallback CT detection from the address string when point-in-polygon misses. */
function looksLikeCtAddress(address?: string | null): boolean {
  if (!address) return false;
  const l = address.toLowerCase();
  return (
    /,\s*ct\b/.test(l) ||
    l.includes('connecticut') ||
    DISTRESSED_MUNIS.some((c) => l.includes(c))
  );
}

export async function lookup(input: LookupInput) {
  let { lat, lng } = input;
  const { address } = input;
  let matchedAddress: string | null = address ?? null;

  // Address-only submissions get geocoded (free, key-less) so we can run the
  // real point-in-polygon territory match instead of the string fallback.
  if ((lat == null || lng == null) && address) {
    const geo = await geocodeOneline(address);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      matchedAddress = geo.matchedAddress;
    }
  }

  const territory = lat != null && lng != null ? resolveTerritory(lat, lng) : null;
  const utilityName = territory?.utilityName ?? null;
  const state = territory?.state ?? (looksLikeCtAddress(matchedAddress) ? SERVED_STATE : null);
  const city = detectCity(matchedAddress);

  // ---- Eligibility -----------------------------------------------------------
  let kind: EligibilityKind;
  let reason: string | undefined;
  if (state === SERVED_STATE) {
    kind = city ? 'PRIORITY' : 'STANDARD';
  } else {
    kind = 'INELIGIBLE';
    reason = state
      ? `We don't operate in ${state} yet — CT Battery Solutions currently serves Connecticut only.`
      : 'This address is outside our Connecticut service area.';
  }

  // ---- Enrichment + incentives ----------------------------------------------
  const enrichmentRow = utilityName ? await getEnrichmentByUtility(utilityName) : null;
  const enrichment = shapeEnrichment(enrichmentRow);
  const incentives = shapeIncentives(enrichmentRow);

  // ---- Tariff defaults -------------------------------------------------------
  const defaults = utilityName
    ? await getTariffDefaults(utilityName)
    : { defaultDemandCharge: 15, defaultTouSpread: 0, defaultRatchet: 80, sampleTariffs: [] };

  const utility = territory
    ? {
        utility_name: territory.utilityName,
        usurdb_name: territory.utilityName,
        eia_id: null as string | null,
        state: territory.state,
        customers: territory.customers,
        control_area: territory.controlArea,
        holding_company: territory.holdingCompany,
        regulated: territory.regulated,
      }
    : null;

  return {
    address: matchedAddress,
    coordinates: lat != null && lng != null ? { lat, lng } : null,
    eligibility: { kind, city, reason },
    utility,
    enrichment,
    incentives,
    state,
    tariffs: defaults.sampleTariffs,
    defaultDemandCharge: defaults.defaultDemandCharge,
    defaultTouSpread: defaults.defaultTouSpread,
    defaultRatchet: defaults.defaultRatchet,
    defaultDrRevenue: enrichmentRow?.drRevenuePerKwYear ?? 0,
    defaultIncentive: enrichmentRow?.incentiveRatePerKwh ?? 0,
  };
}
