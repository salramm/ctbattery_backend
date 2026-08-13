/**
 * ESS program contractor directory. Loads data/ess/ess_contractors.json once and
 * serves a normalized list + individual profiles. Pipe-delimited fields become
 * arrays; lat/long become numbers.
 */
import * as fs from 'fs';
import * as path from 'path';

const FILE = path.join(process.cwd(), 'data', 'ess', 'ess_contractors.json');

export interface EssContractor {
  id: number;
  name: string;
  contractorName: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  lat: number | null;
  lng: number | null;
  awardWinner: boolean;
  propertyTypes: string[];
  services: string[];
  batteryTechnologies: string[];
  logoUrl: string | null;
}

function pipe(v: unknown): string[] {
  return String(v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s || null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let cache: EssContractor[] | null = null;

function load(): EssContractor[] {
  if (cache) return cache;
  let raw: Record<string, unknown>[] = [];
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Record<string, unknown>[];
  } catch {
    raw = [];
  }
  const list: EssContractor[] = raw.map((r) => ({
    id: Number(r.id),
    name: str(r.name) ?? str(r.contractor_name) ?? '',
    contractorName: str(r.contractor_name),
    street1: str(r.street_address1),
    street2: str(r.street_address2),
    city: str(r.city),
    state: str(r.state),
    zip: str(r.zip),
    phone: str(r.phone),
    email: str(r.email),
    website: str(r.website),
    lat: num(r.lat),
    lng: num(r.long),
    awardWinner: String(r.award_winner ?? '').trim().toLowerCase() === 'yes',
    propertyTypes: pipe(r.property_types),
    services: pipe(r.services),
    batteryTechnologies: pipe(r.battery_technologies),
    logoUrl: str(r.logo_url),
  }));
  cache = list;
  return list;
}

export function listContractors(): EssContractor[] {
  return load();
}

export function getContractor(id: number): EssContractor | null {
  return load().find((c) => c.id === id) ?? null;
}
