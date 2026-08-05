/**
 * Utility-territory resolution. Loads the simplified HIFLD GeoJSON once and does
 * in-memory point-in-polygon (@turf) — no PostGIS. Fine at ~2.9k polygons.
 */
import * as fs from 'fs';
import * as path from 'path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';

interface TerritoryProps {
  NAME?: string;
  STATE?: string;
  CNTRL_AREA?: string;
  HOLDING_CO?: string;
  CUSTOMERS?: number;
  ID?: string;
  REGULATED?: string;
}

interface TerritoryFeature {
  type: 'Feature';
  properties: TerritoryProps;
  geometry: any;
}

interface FeatureCollection {
  type: 'FeatureCollection';
  features: TerritoryFeature[];
}

const GEOJSON_PATH = path.join(process.cwd(), 'data', 'territories-simple.geojson');

let cache: FeatureCollection | null = null;

function load(): FeatureCollection {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf-8'));
  cache = { type: 'FeatureCollection', features: (raw.features || []) as TerritoryFeature[] };
  return cache;
}

export interface ResolvedTerritory {
  utilityName: string;
  state: string | null;
  controlArea: string | null;
  holdingCompany: string | null;
  customers: number | null;
  regulated: string | null;
}

/** First territory polygon containing (lat,lng), or null. */
export function resolveTerritory(lat: number, lng: number): ResolvedTerritory | null {
  const pt = point([lng, lat]); // GeoJSON is [lng, lat]
  for (const f of load().features) {
    if (!f.geometry) continue;
    try {
      if (booleanPointInPolygon(pt, f.geometry)) {
        const p = f.properties || {};
        return {
          utilityName: p.NAME || 'Unknown',
          state: p.STATE ?? null,
          controlArea: p.CNTRL_AREA ?? null,
          holdingCompany: p.HOLDING_CO ?? null,
          customers: p.CUSTOMERS ?? null,
          regulated: p.REGULATED ?? null,
        };
      }
    } catch {
      // Skip malformed geometry rather than fail the whole lookup.
    }
  }
  return null;
}

/** Raw FeatureCollection for the map (served as-is). */
export function getTerritoriesGeoJson(): FeatureCollection {
  return load();
}

export function territoryCount(): number {
  return load().features.length;
}
