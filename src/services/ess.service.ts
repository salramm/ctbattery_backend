/**
 * ESS qualification: an address (or coords) → compensation tier + the federal
 * ITC adder stack. Geocodes address-only input via the free Census geocoder,
 * classifies the point against the EJ / distressed-muni layers, and applies the
 * config in src/config/ess.ts.
 */
import { classifyLocation, essDataStatus, type LocationClassification } from './essGeo.service';
import { geocodeOneline } from './geocode.service';
import { ESS_COMPENSATION, ITC } from '../config/ess';

export interface EssQualifyInput {
  lat?: number;
  lng?: number;
  address?: string;
  town?: string;
}

// Pull a town from a Census matched address like "100 MAIN ST, HARTFORD, CT, 06106".
function townFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((s) => s.trim());
  // [..., CITY, STATE, ZIP] — city is third-from-last when a ZIP is present.
  if (parts.length >= 3) return parts[parts.length - 3] || null;
  return null;
}

function buildItc(inNmtcLowIncome: boolean, inEnergyCommunity: boolean) {
  const geoApplies: Record<string, boolean> = {
    low_income: inNmtcLowIncome, // NMTC qualified low-income census tract (§48(e) Cat 1)
    energy_community: inEnergyCommunity, // NETL coal-closure + MSA/non-MSA FFE
  };
  const adders = ITC.adders.map((a) => ({
    key: a.key,
    label: a.label,
    pct: a.pct,
    basis: a.basis,
    // geo adders auto-apply from the datasets; equipment/other need review.
    applies: a.basis === 'geo' ? (geoApplies[a.key] ?? false) : null,
  }));
  const confirmedPct = adders
    .filter((a) => a.applies === true)
    .reduce((sum, a) => sum + a.pct, ITC.basePct as number);
  const potentialPct = adders
    .filter((a) => a.applies !== false)
    .reduce((sum, a) => sum + a.pct, ITC.basePct as number);
  return { basePct: ITC.basePct, adders, confirmedPct, potentialPct };
}

/**
 * Compact ESS/ITC qualification snapshot + a lucrative-ness score, for storing
 * on an LOI and prioritizing the pipeline. Never throws — returns nulls on failure.
 * Score = confirmed ITC % + 20 for the enhanced ESS tier (range ~30–70).
 */
export async function qualifyForStorage(address: string) {
  try {
    const q = await qualifyEss({ address });
    if (!q.located || !q.categories) return null;
    const c = q.categories;
    const itcConfirmedPct = q.itc?.confirmedPct ?? null;
    const itcPotentialPct = q.itc?.potentialPct ?? null;
    const lucrativeScore = (itcConfirmedPct ?? 30) + (c.underserved ? 20 : 0);
    return {
      essTier: q.tier ?? null,
      underserved: c.underserved,
      energyCommunity: c.inEnergyCommunity,
      nmtcLowIncome: c.inNmtcLowIncome,
      itcConfirmedPct,
      itcPotentialPct,
      lucrativeScore,
    };
  } catch {
    return null;
  }
}

export async function qualifyEss(input: EssQualifyInput) {
  let lat = input.lat;
  let lng = input.lng;
  let address = input.address ?? null;
  let town = input.town ?? null;

  if ((lat == null || lng == null) && address) {
    const geo = await geocodeOneline(address);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      address = geo.matchedAddress;
    }
  }
  if (!town) town = townFromAddress(address);

  if (lat == null || lng == null) {
    return {
      located: false,
      address,
      coordinates: null,
      message: 'Could not locate that address.',
      dataStatus: essDataStatus(),
    };
  }

  const categories: LocationClassification = classifyLocation(lat, lng, town);
  const tierConfig = categories.underserved ? ESS_COMPENSATION.underserved : ESS_COMPENSATION.base;

  const reasons: string[] = [];
  if (categories.inEjBlockGroup) reasons.push('In an Environmental Justice block group');
  if (categories.inDistressedMuni) reasons.push(`In a distressed municipality${categories.matchedMuni ? ` (${categories.matchedMuni})` : ''}`);
  if (categories.inGracePeriod) reasons.push('In a grace-period town (previously distressed)');
  if (categories.inEnergyCommunity) {
    const ecType = categories.energyCommunity?.category === 'coal_closure' ? 'coal-closure tract' : 'fossil-fuel-employment area';
    reasons.push(`In an IRA Energy Community — ${ecType} (+10% ITC)`);
  }
  if (categories.inNmtcLowIncome) {
    reasons.push('In an NMTC low-income census tract — §48(e) Cat 1 (+10% ITC)');
  }

  return {
    located: true,
    address,
    coordinates: { lat, lng },
    town,
    tier: tierConfig.key,
    tierLabel: tierConfig.label,
    categories,
    reasons,
    compensation: {
      oneTimeSignupUsd: tierConfig.oneTimeSignupUsd,
      performanceUsdPerKwhYear: tierConfig.performanceUsdPerKwhYear,
      enhanced: 'enhanced' in tierConfig ? tierConfig.enhanced : false,
    },
    itc: buildItc(categories.inNmtcLowIncome, categories.inEnergyCommunity),
    dataStatus: essDataStatus(),
  };
}
