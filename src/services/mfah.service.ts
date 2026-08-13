/**
 * CT multifamily affordable-housing (MFAH) master list: in-memory cache of the
 * mfah_properties table for address matching (ESS Low-Income auto-qualification
 * + ITC §48(e) Cat 3) and a points layer for the map.
 */
import prisma from '../config/database';

const QUALIFYING_SOURCES = ['LIHTC', 'Public_Housing', 'Section8_Multifamily'];

const ABBR: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', BOULEVARD: 'BLVD', TERRACE: 'TER', CIRCLE: 'CIR', HIGHWAY: 'HWY',
  APARTMENTS: 'APTS', APARTMENT: 'APT', SAINT: 'ST',
};

function normPart(s: string): string {
  return (s || '')
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBR[w] ?? w)
    .join(' ')
    .trim();
}

export function normalizeAddress(address: string, city: string): string {
  return `${normPart(address)}|${normPart(city)}`;
}

export interface MfahRow {
  id: number;
  projectName: string | null;
  address: string;
  city: string;
  zip: string | null;
  units: number | null;
  sources: string[];
  ownerOperator: string | null;
  multiProgramOverlap: boolean;
  lat: number | null;
  lng: number | null;
  normAddress: string;
}

let cache: MfahRow[] | null = null;
let byNorm: Map<string, MfahRow> | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  if (!loading) {
    loading = (async () => {
      const rows = await prisma.mfahProperty.findMany({
        select: {
          id: true, projectName: true, address: true, city: true, zip: true, units: true,
          sources: true, ownerOperator: true, multiProgramOverlap: true, lat: true, lng: true, normAddress: true,
        },
      });
      cache = rows;
      byNorm = new Map(rows.map((r) => [r.normAddress, r]));
    })().catch(() => {
      cache = [];
      byNorm = new Map();
    });
  }
  await loading;
}

/** units >= 5 and in a qualifying affordable-housing program. */
export function mfahQualifies(p: { units: number | null; sources: string[] }): boolean {
  return (p.units ?? 0) >= 5 && p.sources.some((s) => QUALIFYING_SOURCES.includes(s));
}

/** Match an entered address to an MFAH property: normalized string, then proximity. */
export async function matchMfah(
  address: string,
  city: string | null,
  lat?: number,
  lng?: number,
): Promise<MfahRow | null> {
  await ensureLoaded();
  // Entered address may be a full "street, city, state, zip" — match on street.
  const parts = address.split(',').map((s) => s.trim());
  const street = parts[0];
  const c = city || parts[1] || '';
  if (street && c) {
    const hit = byNorm!.get(normalizeAddress(street, c));
    if (hit) return hit;
  }
  // Proximity fallback (~150 m) when we have coordinates.
  if (lat != null && lng != null && cache!.length) {
    const R = 0.0016; // ~150m in degrees
    let best: MfahRow | null = null;
    let bestD = Infinity;
    for (const r of cache!) {
      if (r.lat == null || r.lng == null) continue;
      const d = Math.abs(r.lat - lat) + Math.abs(r.lng - lng);
      if (d < R && d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) return best;
  }
  return null;
}

export async function mfahGeoJSON() {
  await ensureLoaded();
  return {
    type: 'FeatureCollection' as const,
    features: cache!
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
        properties: {
          name: r.projectName || r.address,
          units: r.units,
          sources: r.sources.join(', '),
          city: r.city,
          qualifies: mfahQualifies(r),
        },
      })),
  };
}

export async function mfahStatus() {
  await ensureLoaded();
  return {
    count: cache!.length,
    geocoded: cache!.filter((r) => r.lat != null && r.lng != null).length,
  };
}

/** Reset the cache (used by the loader after a reimport). */
export function invalidateMfahCache() {
  cache = null;
  byNorm = null;
  loading = null;
}
