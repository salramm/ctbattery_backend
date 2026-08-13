/**
 * ESS / ITC qualification. Geocodes (Census), classifies against the EJ /
 * distressed / Energy-Community / NMTC layers, matches the MFAH master list, and
 * applies the CT ESS tier rules + federal §48E ITC stack from src/config/ess.ts.
 */
import { classifyLocation, essDataStatus, type LocationClassification } from './essGeo.service';
import { geocodeOneline } from './geocode.service';
import { matchMfah, mfahQualifies } from './mfah.service';
import { ESS_TIERS, GRID_EDGE_ENROLLMENT_PER_KWH, ITC } from '../config/ess';

export interface EssQualifyInput {
  lat?: number;
  lng?: number;
  address?: string;
  town?: string;
}

function townFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((s) => s.trim());
  if (parts.length >= 3) return parts[parts.length - 3] || null;
  return null;
}

type Adder = { key: string; label: string; pct: number; basis: string; applies: boolean | null };

// §48E stack. Energy Community + Domestic Content stack; LI is Cat 1 XOR Cat 3
// (pick the higher available). `applies`: true = confirmed geo, false = n/a,
// null = potential/needs confirmation (domestic content SKU, Cat 3 benefit-sharing).
function buildItc(inEnergyCommunity: boolean, inNmtcLowIncome: boolean, mfahQualifying: boolean) {
  const adders: Adder[] = [
    { key: 'energy_community', label: 'Energy Community', pct: ITC.energyCommunityPct, basis: 'geo', applies: inEnergyCommunity },
    { key: 'domestic_content', label: 'Domestic Content', pct: ITC.domesticContentPct, basis: 'equipment', applies: null },
  ];
  // Low-Income Community: Cat 3 supersedes Cat 1 when both are available.
  if (mfahQualifying) {
    adders.push({ key: 'li_cat3', label: 'LI Community — §48(e) Cat 3 (MFAH)', pct: ITC.liCat3Pct, basis: 'structural', applies: null });
  } else if (inNmtcLowIncome) {
    adders.push({ key: 'li_cat1', label: 'LI Community — §48(e) Cat 1 (NMTC tract)', pct: ITC.liCat1Pct, basis: 'geo', applies: true });
  }
  const confirmedPct = adders.filter((a) => a.applies === true).reduce((s, a) => s + a.pct, ITC.basePct as number);
  const potentialPct = adders.filter((a) => a.applies !== false).reduce((s, a) => s + a.pct, ITC.basePct as number);
  return { basePct: ITC.basePct, adders, confirmedPct, potentialPct };
}

function pickTier(underserved: boolean, mfahQualifying: boolean) {
  if (mfahQualifying) return ESS_TIERS.LOW_INCOME;
  if (underserved) return ESS_TIERS.UNDERSERVED;
  return ESS_TIERS.STANDARD;
}

/**
 * Compact snapshot + lucrative score for storing on an LOI / prioritizing the
 * pipeline. Score = potential ITC % + tier bonus (Low-Income +30, Underserved +15).
 */
export async function qualifyForStorage(address: string) {
  try {
    const q = await qualifyEss({ address });
    if (!q.located || !q.categories) return null;
    const c = q.categories;
    const itcConfirmedPct = q.itc?.confirmedPct ?? null;
    const itcPotentialPct = q.itc?.potentialPct ?? null;
    const tierBonus = q.tier === 'LOW_INCOME' ? 30 : q.tier === 'UNDERSERVED' ? 15 : 0;
    const lucrativeScore = (itcPotentialPct ?? 30) + tierBonus;
    return {
      essTier: q.tier ?? null,
      underserved: c.underserved || q.tier === 'LOW_INCOME',
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
    return { located: false, address, coordinates: null, message: 'Could not locate that address.', dataStatus: essDataStatus() };
  }

  const geo: LocationClassification = classifyLocation(lat, lng, town);
  const mfah = address ? await matchMfah(address, town, lat, lng) : null;
  const mfahQualifying = !!mfah && mfahQualifies(mfah);

  const tier = pickTier(geo.underserved, mfahQualifying);
  const itc = buildItc(geo.inEnergyCommunity, geo.inNmtcLowIncome, mfahQualifying);

  const reasons: string[] = [];
  if (mfahQualifying) {
    reasons.push(`Affordable-housing property${mfah?.projectName ? ` (${mfah.projectName})` : ''} — ESS Low-Income tier + ITC Cat 3 eligible`);
  }
  if (geo.inEjBlockGroup) reasons.push('In an Environmental Justice block group');
  if (geo.inDistressedMuni) reasons.push(`In a distressed municipality${geo.matchedMuni ? ` (${geo.matchedMuni})` : ''}`);
  if (geo.inGracePeriod) reasons.push('In a grace-period town (previously distressed)');
  if (geo.inEnergyCommunity) {
    const t = geo.energyCommunity?.category === 'coal_closure' ? 'coal-closure tract' : 'fossil-fuel-employment area';
    reasons.push(`In an IRA Energy Community — ${t} (+10% ITC)`);
  }
  if (geo.inNmtcLowIncome && !mfahQualifying) reasons.push('In an NMTC low-income census tract — §48(e) Cat 1 (+10% ITC)');

  return {
    located: true,
    address,
    coordinates: { lat, lng },
    town,
    tier: tier.key,
    tierLabel: tier.label,
    categories: {
      ...geo,
      mfahQualifying,
      mfah: mfah ? { projectName: mfah.projectName, units: mfah.units, sources: mfah.sources, city: mfah.city } : null,
    },
    reasons,
    compensation: {
      enhanced: tier.enhanced,
      enrollmentPerKwh: tier.enrollmentPerKwh,
      gridEdgeEnrollmentPerKwh: GRID_EDGE_ENROLLMENT_PER_KWH,
      gridEdge: 'unconfirmed', // no confirmed programmatic source — verify with CT Green Bank
      performancePerKwYearMin: tier.perfMin,
      performancePerKwYearMax: tier.perfMax,
      // legacy aliases for older mobile builds
      oneTimeSignupUsd: tier.enrollmentPerKwh,
      performanceUsdPerKwhYear: tier.perfMin,
    },
    itc,
    dataStatus: essDataStatus(),
  };
}
