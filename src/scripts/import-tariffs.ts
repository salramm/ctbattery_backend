/**
 * Imports OpenEI USURDB commercial & industrial rate tariffs into RateTariff.
 * Reads data/usurdb.json (gitignored, ~177 MB), filters to C&I, batch-inserts.
 * Idempotent-ish: truncates RateTariff first, then bulk-inserts.
 * Run: npm run import:tariffs
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';

const FILE = path.join(process.cwd(), 'data', 'usurdb.json');
const BATCH = 2000;

function extractDate(field: any): string | null {
  if (!field) return null;
  try {
    if (typeof field === 'object' && field.$date) {
      if (typeof field.$date === 'string') return field.$date.split('T')[0];
      if (typeof field.$date === 'number') return new Date(field.$date).toISOString().split('T')[0];
      return null;
    }
    if (typeof field === 'string') return field.split('T')[0];
    if (typeof field === 'number') return new Date(field * 1000).toISOString().split('T')[0];
  } catch {
    return null;
  }
  return null;
}

function extractId(rate: any): string | null {
  const id = rate._id;
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && id.$oid) return id.$oid;
  return JSON.stringify(id);
}

// JSON columns: pass the object through (Prisma stores it), or DbNull when absent.
const asJson = (v: any): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

const num = (v: any): number | null =>
  v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

function toRow(rate: any): Prisma.RateTariffCreateManyInput | null {
  const sector = (rate.sector || '').toLowerCase();
  if (!sector.includes('commercial') && !sector.includes('industrial')) return null;

  const label = extractId(rate);
  if (!label) return null;

  return {
    label,
    utilityName: rate.utilityName || rate.utility || 'Unknown',
    eiaId: rate.eiaId?.toString() || null,
    rateName: rate.rateName || rate.name || 'Unnamed',
    sector: rate.sector || null,
    serviceType: rate.serviceType || null,
    description: rate.description || null,
    sourceUrl: rate.sourceReference || rate.source || null,
    isDefault: !!rate.isDefault,
    approved: !!rate.approved,
    startDate: extractDate(rate.effectiveDate || rate.startdate),
    endDate: extractDate(rate.endDate || rate.enddate),

    flatDemandUnit: rate.flatDemandUnits || rate.flatdemandunit || null,
    flatDemandStructure: asJson(rate.flatDemandStrux || rate.flatdemandstructure),
    flatDemandMonths: asJson(rate.flatDemandMonths || rate.flatdemandmonths),
    demandRateUnit: rate.demandRateUnits || rate.demandrateunit || null,
    demandRateStructure: asJson(rate.demandRateStrux || rate.demandratestructure),
    demandWeekdaySchedule: asJson(rate.demandWeekdaySched || rate.demandweekdayschedule),
    demandWeekendSchedule: asJson(rate.demandWeekendSched || rate.demandweekendschedule),
    demandRatchetPercentage: num(rate.demandRatchetPct || rate.demandratchetpercentage),
    demandWindow: num(rate.demandWindow || rate.demandwindow),
    demandReactivePowerCharge: num(rate.demandReactivePowerChg || rate.demandreactivepowercharge),

    coincidentRateUnit: rate.coincidentRateUnits || rate.coincidentrateunit || null,
    coincidentRateStructure: asJson(rate.coincidentRateStrux || rate.coincidentratestructure),
    coincidentSchedule: asJson(rate.coincidentSched || rate.coincidentschedule),

    energyRateUnit: rate.energyRateUnits || 'kWh',
    energyRateStructure: asJson(rate.energyRateStrux || rate.energyratestructure),
    energyWeekdaySchedule: asJson(rate.energyWeekdaySched || rate.energyweekdayschedule),
    energyWeekendSchedule: asJson(rate.energyWeekendSched || rate.energyweekendschedule),

    fixedMonthlyCharge: num(rate.fixedChargeFirstMeter || rate.fixedmonthlycharge),
    minMonthlyCharge: num(rate.minCharge || rate.minmonthlycharge),
    annualMinCharge: num(rate.annualMinCharge || rate.annualmincharge),

    peakKwCapacityMin: num(rate.demandMin || rate.peakkwcapacitymin),
    peakKwCapacityMax: num(rate.demandMax || rate.peakkwcapacitymax),
    usesNetMetering: (rate.dgRules || '').toLowerCase().includes('net metering'),

    rawJson: asJson(rate),
  };
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`USURDB file not found at ${FILE}`);
    console.error('Download: curl -o data/usurdb.json.gz "https://apps.openei.org/USURDB/download/usurdb.json.gz" && gunzip data/usurdb.json.gz');
    process.exit(1);
  }

  console.log('Reading USURDB JSON (large file, may take a moment)...');
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  const rates: any[] = Array.isArray(raw) ? raw : raw.items || [];
  console.log(`Processing ${rates.length} total rates...`);

  console.log('Clearing existing rate_tariffs...');
  await prisma.rateTariff.deleteMany({});

  let batch: Prisma.RateTariffCreateManyInput[] = [];
  let loaded = 0;
  let skipped = 0;
  const seen = new Set<string>();

  const flush = async () => {
    if (batch.length === 0) return;
    const res = await prisma.rateTariff.createMany({ data: batch, skipDuplicates: true });
    loaded += res.count;
    batch = [];
  };

  for (const rate of rates) {
    const row = toRow(rate);
    if (!row) {
      skipped++;
      continue;
    }
    // De-dupe on unique label within this run (createMany can't dedupe across batches).
    if (seen.has(row.label)) continue;
    seen.add(row.label);
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const total = await prisma.rateTariff.count();
  const coned = await prisma.rateTariff.count({
    where: { utilityName: { contains: 'Consolidated Edison' } },
  });
  console.log('\nTariff import complete.');
  console.log(`  Loaded: ${loaded}`);
  console.log(`  Skipped (non-C&I or no ID): ${skipped}`);
  console.log(`  Total in DB: ${total}`);
  console.log(`  ConEd rates: ${coned}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
