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

// ---- ESS compensation tiers ------------------------------------------------
// Base applies to any qualifying CT address; underserved applies inside an EJ
// block group, a distressed municipality, or a grace-period town.
export const ESS_COMPENSATION = {
  base: {
    key: 'BASE',
    label: 'Standard',
    oneTimeSignupUsd: 30,
    performanceUsdPerKwhYear: 300,
  },
  underserved: {
    key: 'UNDERSERVED',
    label: 'Underserved (EJ / distressed)',
    oneTimeSignupUsd: 30, // CONFIRM underserved figures
    performanceUsdPerKwhYear: 300, // CONFIRM underserved uplift
    enhanced: true,
  },
} as const;

// ---- Federal ITC adder stack (percent of eligible basis) -------------------
// Base ITC 30%. Adders stack; geographic ones auto-flag from the datasets,
// equipment/community ones need separate confirmation.
export const ITC = {
  basePct: 30,
  adders: [
    {
      key: 'low_income',
      label: 'Low-Income Community (§48 (e))',
      pct: 10,
      basis: 'geo', // auto-applies in qualifying EJ / low-income areas
    },
    {
      key: 'energy_community',
      label: 'Energy Community',
      pct: 10,
      basis: 'external', // needs federal energy-community mapping
    },
    {
      key: 'domestic_content',
      label: 'Domestic Content',
      pct: 10,
      basis: 'equipment', // depends on hardware sourcing
    },
  ],
} as const;
