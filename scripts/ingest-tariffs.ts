// scripts/ingest-tariffs.ts
// Run with: npx tsx scripts/ingest-tariffs.ts
//
// Loads USURDB bulk JSON into the SQLite rate_tariffs table.
// Filters to commercial/industrial rates only.
//
// USURDB field names are camelCase (rateName, utilityName, flatDemandStrux, etc.)
// Unique ID is _id.$oid

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'gridshift.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS rate_tariffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,
    utility_name TEXT NOT NULL,
    eia_id TEXT,
    rate_name TEXT NOT NULL,
    sector TEXT,
    service_type TEXT,
    description TEXT,
    source_url TEXT,
    is_default INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    flat_demand_unit TEXT,
    flat_demand_structure TEXT,
    flat_demand_months TEXT,
    demand_rate_unit TEXT,
    demand_rate_structure TEXT,
    demand_weekday_schedule TEXT,
    demand_weekend_schedule TEXT,
    demand_ratchet_percentage REAL,
    demand_window INTEGER,
    demand_reactive_power_charge REAL,
    coincident_rate_unit TEXT,
    coincident_rate_structure TEXT,
    coincident_schedule TEXT,
    energy_rate_unit TEXT,
    energy_rate_structure TEXT,
    energy_weekday_schedule TEXT,
    energy_weekend_schedule TEXT,
    fixed_monthly_charge REAL,
    min_monthly_charge REAL,
    annual_min_charge REAL,
    peak_kw_capacity_min REAL,
    peak_kw_capacity_max REAL,
    uses_net_metering INTEGER DEFAULT 0,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tariffs_utility ON rate_tariffs (utility_name);
  CREATE INDEX IF NOT EXISTS idx_tariffs_eia ON rate_tariffs (eia_id);
  CREATE INDEX IF NOT EXISTS idx_tariffs_sector ON rate_tariffs (sector);
`);

// Load USURDB JSON
const filePath = path.join(process.cwd(), 'data', 'usurdb.json');

if (!fs.existsSync(filePath)) {
  console.error('Error: USURDB JSON file not found at:', filePath);
  console.error('Download it with:');
  console.error('  curl -o data/usurdb.json.gz "https://apps.openei.org/USURDB/download/usurdb.json.gz"');
  console.error('  gunzip data/usurdb.json.gz');
  process.exit(1);
}

console.log('Reading USURDB JSON file...');
const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
// USURDB bulk is a direct array (not { items: [...] })
const rates: any[] = Array.isArray(raw) ? raw : (raw.items || []);

console.log(`Processing ${rates.length} total rates...`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO rate_tariffs (
    label, utility_name, eia_id, rate_name, sector, service_type,
    description, source_url, is_default, approved, start_date, end_date,
    flat_demand_unit, flat_demand_structure, flat_demand_months,
    demand_rate_unit, demand_rate_structure,
    demand_weekday_schedule, demand_weekend_schedule,
    demand_ratchet_percentage, demand_window, demand_reactive_power_charge,
    coincident_rate_unit, coincident_rate_structure, coincident_schedule,
    energy_rate_unit, energy_rate_structure,
    energy_weekday_schedule, energy_weekend_schedule,
    fixed_monthly_charge, min_monthly_charge, annual_min_charge,
    peak_kw_capacity_min, peak_kw_capacity_max, uses_net_metering,
    raw_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?
  )
`);

function extractDate(field: any): string | null {
  if (!field) return null;
  try {
    // USURDB dates are { $date: "2012-02-22T01:00:00Z" } or { $date: number }
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
  // _id can be { $oid: "..." } or a string
  const id = rate._id;
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && id.$oid) return id.$oid;
  return JSON.stringify(id);
}

const toJson = (v: any) => (v ? JSON.stringify(v) : null);

const insertMany = db.transaction((items: any[]) => {
  let loaded = 0;
  let skipped = 0;
  for (const rate of items) {
    const sector = (rate.sector || '').toLowerCase();
    if (!sector.includes('commercial') && !sector.includes('industrial')) {
      skipped++;
      continue;
    }

    // Use _id.$oid as the unique label
    const label = extractId(rate);
    if (!label) {
      skipped++;
      continue;
    }

    insert.run(
      label,
      rate.utilityName || rate.utility || 'Unknown',
      rate.eiaId?.toString() || null,
      rate.rateName || rate.name || 'Unnamed',
      rate.sector || null,
      rate.serviceType || null,
      rate.description || null,
      rate.sourceReference || rate.source || null,
      rate.isDefault ? 1 : 0,
      rate.approved ? 1 : 0,
      extractDate(rate.effectiveDate || rate.startdate),
      extractDate(rate.endDate || rate.enddate),
      rate.flatDemandUnits || rate.flatdemandunit || null,
      toJson(rate.flatDemandStrux || rate.flatdemandstructure),
      toJson(rate.flatDemandMonths || rate.flatdemandmonths),
      rate.demandRateUnits || rate.demandrateunit || null,
      toJson(rate.demandRateStrux || rate.demandratestructure),
      toJson(rate.demandWeekdaySched || rate.demandweekdayschedule),
      toJson(rate.demandWeekendSched || rate.demandweekendschedule),
      rate.demandRatchetPct || rate.demandratchetpercentage || null,
      rate.demandWindow || rate.demandwindow || null,
      rate.demandReactivePowerChg || rate.demandreactivepowercharge || null,
      rate.coincidentRateUnits || rate.coincidentrateunit || null,
      toJson(rate.coincidentRateStrux || rate.coincidentratestructure),
      toJson(rate.coincidentSched || rate.coincidentschedule),
      rate.energyRateUnits || 'kWh',
      toJson(rate.energyRateStrux || rate.energyratestructure),
      toJson(rate.energyWeekdaySched || rate.energyweekdayschedule),
      toJson(rate.energyWeekendSched || rate.energyweekendschedule),
      rate.fixedChargeFirstMeter || rate.fixedmonthlycharge || null,
      rate.minCharge || rate.minmonthlycharge || null,
      rate.annualMinCharge || rate.annualmincharge || null,
      rate.demandMin || rate.peakkwcapacitymin || null,
      rate.demandMax || rate.peakkwcapacitymax || null,
      (rate.dgRules || '').toLowerCase().includes('net metering') ? 1 : 0,
      JSON.stringify(rate)
    );
    loaded++;
  }
  return { loaded, skipped };
});

const result = insertMany(rates);
console.log('');
console.log('Tariff ingestion complete.');
console.log(`  Loaded: ${result.loaded}`);
console.log(`  Skipped (non-C&I or no ID): ${result.skipped}`);

// Show stats
const count = db.prepare('SELECT COUNT(*) as cnt FROM rate_tariffs').get() as any;
const conedCount = db.prepare("SELECT COUNT(*) as cnt FROM rate_tariffs WHERE utility_name LIKE '%Consolidated Edison%'").get() as any;
console.log(`  Total in DB: ${count.cnt}`);
console.log(`  ConEd rates: ${conedCount.cnt}`);

db.close();
