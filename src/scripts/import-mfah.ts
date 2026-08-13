/**
 * Load CT_MFAH_Master_List.csv into mfah_properties, then geocode every row via
 * the free Census geocoder to backfill lat/lng. Idempotent: clears + reloads.
 *
 *   npx ts-node src/scripts/import-mfah.ts        (local)
 *   node dist/scripts/import-mfah.js              (prod container)
 */
import * as fs from 'fs';
import * as path from 'path';
import prisma from '../config/database';
import { normalizeAddress } from '../services/mfah.service';
import { geocodeOneline } from '../services/geocode.service';

const CSV_PATH = path.join(process.cwd(), 'data', 'ess', 'CT_MFAH_Master_List.csv');

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCsv(raw);
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iName = idx('project_name'), iAddr = idx('address'), iCity = idx('city'), iZip = idx('zip');
  const iUnits = idx('units'), iSources = idx('sources'), iOwner = idx('owner_operator'),
    iEmail = idx('contact_email'), iOverlap = idx('multi_program_overlap');

  const records = rows.slice(1).filter((r) => r[iAddr] && r[iCity]).map((r) => ({
    projectName: r[iName]?.trim() || null,
    address: r[iAddr].trim(),
    city: r[iCity].trim(),
    zip: r[iZip]?.trim() || null,
    units: r[iUnits] && !Number.isNaN(Number(r[iUnits])) ? parseInt(r[iUnits], 10) : null,
    sources: (r[iSources] || '').split(';').map((s) => s.trim()).filter(Boolean),
    ownerOperator: r[iOwner]?.trim() || null,
    contactEmail: r[iEmail]?.trim() || null,
    multiProgramOverlap: (r[iOverlap] || '').trim().toLowerCase() === 'yes',
    normAddress: normalizeAddress(r[iAddr], r[iCity]),
  }));

  console.log(`Parsed ${records.length} MFAH rows. Clearing + inserting…`);
  await prisma.mfahProperty.deleteMany();
  for (let i = 0; i < records.length; i += 500) {
    await prisma.mfahProperty.createMany({ data: records.slice(i, i + 500) });
  }

  if (process.env.SKIP_GEOCODE) {
    console.log(`Inserted ${await prisma.mfahProperty.count()} (geocoding skipped).`);
    return;
  }
  // Geocode (Census) with modest concurrency; backfill lat/lng.
  const all = await prisma.mfahProperty.findMany({ select: { id: true, address: true, city: true, zip: true } });
  console.log(`Geocoding ${all.length} rows via Census…`);
  const CONCURRENCY = 8;
  let done = 0, hit = 0;
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (p) => {
        const q = `${p.address}, ${p.city}, CT ${p.zip ?? ''}`.trim();
        const geo = await geocodeOneline(q);
        if (geo) {
          hit++;
          await prisma.mfahProperty.update({ where: { id: p.id }, data: { lat: geo.lat, lng: geo.lng } });
        }
      }),
    );
    done += batch.length;
    if (done % 200 === 0 || done === all.length) console.log(`  geocoded ${done}/${all.length} (${hit} located)`);
  }

  const total = await prisma.mfahProperty.count();
  const geocoded = await prisma.mfahProperty.count({ where: { lat: { not: null } } });
  console.log(`Done: ${total} properties, ${geocoded} geocoded.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
