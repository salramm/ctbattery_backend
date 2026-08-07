/**
 * Free, key-less geocoding for the consumer qualify flow.
 *
 * - geocodeOneline: US Census Bureau geocoder (address → lat/lng). No key, no
 *   billing, accurate for US residential addresses. Used by /api/lookup when an
 *   address is submitted without coordinates.
 * - suggestAddresses: Photon (OpenStreetMap, Komoot) typeahead, biased to the
 *   Connecticut bounding box. No key. Returns suggestions WITH coordinates so a
 *   picked suggestion needs no second geocode.
 */

// Connecticut bounding box (west, south, east, north) to focus suggestions.
const CT_BBOX = '-73.7277,40.9509,-71.7869,42.0506';

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const PHOTON_URL = 'https://photon.komoot.io/api/';

async function fetchJson(url: string, timeoutMs = 4000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ct-battery-solutions/1.0 (qualify-flow)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  matchedAddress: string;
}

export async function geocodeOneline(address: string): Promise<GeocodeResult | null> {
  const url =
    `${CENSUS_URL}?address=${encodeURIComponent(address)}` +
    `&benchmark=Public_AR_Current&format=json`;
  const json = (await fetchJson(url)) as
    | { result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x: number; y: number } }> } }
    | null;
  const match = json?.result?.addressMatches?.[0];
  const coords = match?.coordinates;
  if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') return null;
  return { lat: coords.y, lng: coords.x, matchedAddress: match?.matchedAddress ?? address };
}

export interface AddressSuggestion {
  label: string;
  lat: number;
  lng: number;
}

interface PhotonProps {
  housenumber?: string;
  street?: string;
  name?: string;
  city?: string;
  district?: string;
  state?: string;
  postcode?: string;
  countrycode?: string;
}

function photonLabel(p: PhotonProps): string {
  const line1 = [p.housenumber, p.street].filter(Boolean).join(' ') || p.name || '';
  const locality = p.city || p.district;
  const line2 = [locality, p.state, p.postcode].filter(Boolean).join(', ');
  return [line1, line2].filter(Boolean).join(', ');
}

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const url =
    `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=6&lang=en&bbox=${CT_BBOX}`;
  const json = (await fetchJson(url, 3000)) as
    | { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: PhotonProps }> }
    | null;
  const features = json?.features ?? [];
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const p = f.properties ?? {};
    if (p.countrycode && p.countrycode !== 'US') continue;
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length !== 2) continue;
    const label = photonLabel(p);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, lat: coords[1], lng: coords[0] });
  }
  return out;
}
