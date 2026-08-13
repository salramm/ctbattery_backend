/**
 * Connecticut Energy Storage Solutions (ESS) qualification config.
 *
 * Compensation tiers + the federal ITC adder stack, plus the geo-data file map
 * and property-name candidates. Amounts/percentages are intentionally centralized
 * here so program updates are one edit. Values marked CONFIRM are placeholders
 * pending the official underserved figures.
 */
import * as path from 'path';

export const ESS_DATA_DIR = path.join(process.cwd(), 'data', 'ess');

// Layer name (URL slug) → file + human label. Slugs are what the map/API use.
export const ESS_LAYERS = {
  'ej-block-groups': {
    file: 'ej-block-groups-2025.geojson',
    label: 'Environmental Justice Block Groups (2025)',
  },
  'distressed-municipalities': {
    file: 'distressed-municipalities-2025.geojson',
    label: 'EJ Distressed Municipalities (2025)',
  },
  'energy-communities': {
    file: 'energy-communities-2024.geojson',
    label: 'IRA Energy Communities (+10% ITC)',
  },
  'nmtc-low-income': {
    file: 'nmtc-low-income-2020.geojson',
    label: 'NMTC Low-Income Communities (§48(e) Cat 1, +10% ITC)',
  },
} as const;

export type EssLayerName = keyof typeof ESS_LAYERS;

// Property keys to read a municipality/town name from distressed-muni features.
export const MUNI_NAME_KEYS = [
  'TOWN', 'NAME', 'name', 'Municipality', 'MUNICIPALITY', 'town', 'Town', 'MUNI', 'GEONAME',
];

// Property keys carrying the grace-period flag on a distressed-muni feature, and
// the values that mean "in grace period" (previously distressed, still eligible).
export const MUNI_GRACE_KEYS = ['GRACE_PERIOD', 'grace_period', 'GracePeriod', 'GRACE'];
export const GRACE_TRUE_VALUES = ['yes', 'y', 'true', '1'];

// Optional extra grace-period towns (case-insensitive) beyond what the dataset's
// grace flag already marks. Usually empty since the flag drives it.
export const GRACE_PERIOD_TOWNS: string[] = [];

// ---- ESS compensation tiers (CT Energy Storage Solutions) ------------------
// Priority: LOW_INCOME (MFAH auto-qualify) > UNDERSERVED (EJ / distressed) > STANDARD.
// Enrollment is a one-time $/kWh at commissioning; performance is a 10-yr annual
// $/kW-yr (Active Dispatch). Grid Edge would raise enrollment to $130/kWh but has
// no confirmed programmatic source — surfaced as "unconfirmed", never defaulted.
export const ESS_TIERS = {
  STANDARD: { key: 'STANDARD', label: 'Standard', enrollmentPerKwh: 30, perfMin: 300, perfMax: 300, enhanced: false },
  UNDERSERVED: { key: 'UNDERSERVED', label: 'Underserved', enrollmentPerKwh: 30, perfMin: 425, perfMax: 450, enhanced: true },
  LOW_INCOME: { key: 'LOW_INCOME', label: 'Low-Income', enrollmentPerKwh: 30, perfMin: 525, perfMax: 550, enhanced: true },
} as const;

export const GRID_EDGE_ENROLLMENT_PER_KWH = 130;

// ---- Federal ITC (§48E) adder percentages ----------------------------------
// Base 30% (auto for <1 MW — no prevailing-wage burden). Energy Community and
// Domestic Content stack. The Low-Income Community adder is Cat 1 XOR Cat 3
// (mutually exclusive — pick the higher available): Cat 1 (+10%) is purely
// geographic (NMTC tract); Cat 3 (+20%) is structural (MFAH + benefit-sharing).
export const ITC = {
  basePct: 30,
  energyCommunityPct: 10,
  domesticContentPct: 10,
  liCat1Pct: 10, // NMTC low-income tract (geographic)
  liCat3Pct: 20, // MFAH qualified low-income residential building (structural)
} as const;
