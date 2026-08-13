/**
 * ESS underserved-geography classifier. Loads the EJ block-group and distressed-
 * municipality GeoJSON layers once (if present) and does in-memory
 * point-in-polygon (@turf), mirroring territory.service. Degrades gracefully when
 * the data files haven't been dropped in yet.
 */
import * as fs from 'fs';
import * as path from 'path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import {
  ESS_DATA_DIR,
  ESS_LAYERS,
  MUNI_NAME_KEYS,
  MUNI_GRACE_KEYS,
  GRACE_TRUE_VALUES,
  GRACE_PERIOD_TOWNS,
  type EssLayerName,
} from '../config/ess';

type Feature = { type: 'Feature'; properties: Record<string, unknown> | null; geometry: unknown };
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

const cache = new Map<EssLayerName, FeatureCollection | null>();
let loaded = false;

function loadFile(file: string): FeatureCollection | null {
  const p = path.join(ESS_DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { type: 'FeatureCollection', features: (raw.features || []) as Feature[] };
  } catch {
    return null;
  }
}

function ensureLoaded() {
  if (loaded) return;
  (Object.keys(ESS_LAYERS) as EssLayerName[]).forEach((name) => {
    cache.set(name, loadFile(ESS_LAYERS[name].file));
  });
  loaded = true;
}

export function getLayer(name: EssLayerName): FeatureCollection | null {
  ensureLoaded();
  return cache.get(name) ?? null;
}

export function essDataStatus() {
  ensureLoaded();
  const ej = cache.get('ej-block-groups');
  const muni = cache.get('distressed-municipalities');
  return {
    layers: (Object.keys(ESS_LAYERS) as EssLayerName[]).map((name) => ({
      name,
      label: ESS_LAYERS[name].label,
      loaded: !!cache.get(name),
      features: cache.get(name)?.features.length ?? 0,
    })),
    ejBlockGroupsLoaded: !!ej,
    distressedMunisLoaded: !!muni,
    gracePeriodTowns: GRACE_PERIOD_TOWNS.length,
  };
}

function readMuniName(props: Record<string, unknown> | null): string | null {
  if (!props) return null;
  for (const k of MUNI_NAME_KEYS) {
    const v = props[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function readGraceFlag(props: Record<string, unknown> | null): boolean {
  if (!props) return false;
  for (const k of MUNI_GRACE_KEYS) {
    if (props[k] != null) return GRACE_TRUE_VALUES.includes(String(props[k]).trim().toLowerCase());
  }
  return false;
}

export interface LocationClassification {
  inEjBlockGroup: boolean;
  ejBlockGroupId: string | null;
  inDistressedMuni: boolean;
  matchedMuni: string | null;
  inGracePeriod: boolean;
  underserved: boolean;
  inEnergyCommunity: boolean;
  energyCommunity: { category: string | null; name: string | null } | null;
  inNmtcLowIncome: boolean;
  nmtcTract: { geoid: string | null; basis: string | null } | null;
}

export function classifyLocation(lat: number, lng: number, town?: string | null): LocationClassification {
  ensureLoaded();
  const pt = point([lng, lat]);

  let inEj = false;
  let ejId: string | null = null;
  const ej = cache.get('ej-block-groups');
  if (ej) {
    for (const f of ej.features) {
      if (f.geometry && booleanPointInPolygon(pt, f as never)) {
        inEj = true;
        ejId = (f.properties?.GEOID ?? f.properties?.geoid ?? null) as string | null;
        break;
      }
    }
  }

  // A point can land in a distressed-muni polygon; the feature's grace flag says
  // whether it's an active distressed town or a grace-period (previously listed) one.
  let inMuniPolygon = false;
  let matchedMuni: string | null = null;
  let graceFlag = false;
  const muni = cache.get('distressed-municipalities');
  if (muni) {
    for (const f of muni.features) {
      if (f.geometry && booleanPointInPolygon(pt, f as never)) {
        inMuniPolygon = true;
        matchedMuni = readMuniName(f.properties);
        graceFlag = readGraceFlag(f.properties);
        break;
      }
    }
  }

  // Config list can add grace towns beyond the dataset flag (by town name).
  const t = (town || matchedMuni || '').toLowerCase();
  const inGraceList = !!t && GRACE_PERIOD_TOWNS.some((g) => g.toLowerCase() === t);
  const inGrace = (inMuniPolygon && graceFlag) || inGraceList;
  const inDistressed = inMuniPolygon && !graceFlag;

  // IRA Energy Community (§48 +10% ITC) — separate from the ESS underserved tier.
  let inEc = false;
  let ecCat: string | null = null;
  let ecName: string | null = null;
  const ec = cache.get('energy-communities');
  if (ec) {
    for (const f of ec.features) {
      if (f.geometry && booleanPointInPolygon(pt, f as never)) {
        inEc = true;
        ecCat = (f.properties?.category as string) ?? null;
        ecName = (f.properties?.name as string) ?? null;
        break;
      }
    }
  }

  // NMTC low-income community (§48(e) Cat 1 +10% ITC).
  let inNmtc = false;
  let nmtcGeoid: string | null = null;
  let nmtcBasis: string | null = null;
  const nmtc = cache.get('nmtc-low-income');
  if (nmtc) {
    for (const f of nmtc.features) {
      if (f.geometry && booleanPointInPolygon(pt, f as never)) {
        inNmtc = true;
        nmtcGeoid = (f.properties?.geoid as string) ?? null;
        nmtcBasis = (f.properties?.basis as string) ?? null;
        break;
      }
    }
  }

  return {
    inEjBlockGroup: inEj,
    ejBlockGroupId: ejId,
    inDistressedMuni: inDistressed,
    matchedMuni,
    inGracePeriod: inGrace,
    underserved: inEj || inMuniPolygon || inGraceList,
    inEnergyCommunity: inEc,
    energyCommunity: inEc ? { category: ecCat, name: ecName } : null,
    inNmtcLowIncome: inNmtc,
    nmtcTract: inNmtc ? { geoid: nmtcGeoid, basis: nmtcBasis } : null,
  };
}
