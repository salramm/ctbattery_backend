// scripts/seed-enrichment.ts
// Run with: npx tsx scripts/seed-enrichment.ts
//
// Seeds the gridshift_enrichment table with proprietary market data
// for the 5 target utility territories.

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'gridshift.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS gridshift_enrichment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility_name TEXT NOT NULL,
    state TEXT NOT NULL,
    iso_rto TEXT,
    dr_program_name TEXT,
    dr_program_type TEXT,
    dr_revenue_per_kw_year REAL,
    dr_season_start TEXT,
    dr_season_end TEXT,
    dr_events_per_year INTEGER,
    dr_enrollment_method TEXT,
    incentive_program TEXT,
    incentive_rate_per_kwh REAL,
    incentive_block_name TEXT,
    incentive_remaining_mwh REAL,
    incentive_url TEXT,
    cpace_available INTEGER DEFAULT 0,
    cpace_administrator TEXT,
    cpace_administrator_contact TEXT,
    cpace_counties_opted_in TEXT,
    interconnection_process TEXT,
    interconnection_timeline_weeks INTEGER,
    green_button_cmd_available INTEGER DEFAULT 0,
    avg_permit_timeline_weeks INTEGER,
    fire_review_required INTEGER DEFAULT 0,
    special_requirements TEXT,
    bess_score INTEGER,
    primary_revenue_driver TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_enrichment_utility ON gridshift_enrichment (utility_name);
  CREATE INDEX IF NOT EXISTS idx_enrichment_state ON gridshift_enrichment (state);
`);

// Clear existing data for clean re-seed
db.exec('DELETE FROM gridshift_enrichment');

const insert = db.prepare(`
  INSERT INTO gridshift_enrichment (
    utility_name, state, iso_rto, dr_program_name, dr_program_type,
    dr_revenue_per_kw_year, dr_season_start, dr_season_end, dr_events_per_year,
    dr_enrollment_method, incentive_program, incentive_rate_per_kwh,
    incentive_block_name, incentive_remaining_mwh, cpace_available,
    cpace_administrator, cpace_counties_opted_in, interconnection_process,
    interconnection_timeline_weeks, green_button_cmd_available,
    avg_permit_timeline_weeks, fire_review_required, bess_score,
    primary_revenue_driver, notes
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const data = [
  [
    'Consolidated Edison Co-NY Inc', 'NY', 'NYISO',
    'CSRP + DLRP (Rider T)', 'event-based', 300, 'May 1', 'Sep 30', 10,
    'Aggregator (Rider T registration required)', 'NYSERDA Retail Storage', 175,
    'ROS-5', 256, 1, 'EIC Open C-PACE (suburbs) / NYCEEC (NYC)',
    '["Westchester","Nassau","Rockland","NYC"]',
    'ConEd CESIR (>300kW) or SIR (<300kW)', 8, 1, 3, 0, 95,
    'demand_charges',
    'SC9 Rate II primary target. Combined demand $34.30/kW. Westchester suburbs preferred over NYC (no FDNY T-90).',
  ],
  [
    'PSEG Long Island', 'NY', 'NYISO',
    'Dynamic Load Management + Battery Storage Rewards', 'event-based', 200,
    'May 1', 'Sep 30', 8, 'Direct enrollment with PSEG LI',
    'NYSERDA Retail Storage', 175, 'ROS-5', 256, 1, 'EIC Open C-PACE',
    '["Nassau","Suffolk"]', 'LIPA SIR', 6, 0, 3, 0, 80,
    'demand_charges',
    'LIPA Rate 281 for large commercial. Lower demand charges than ConEd ($12-25/kW). Green Button limited.',
  ],
  [
    'NSTAR Electric Company', 'MA', 'ISO-NE',
    'ConnectedSolutions', 'daily-dispatch', 350, 'Jun 1', 'Sep 30', 60,
    'Through participating vendor (GridShift)', 'MA SMART Storage Adder', 0,
    'N/A', 0, 1, 'MassDevelopment', '["statewide"]', 'ISO-NE SIR', 6, 1, 2,
    0, 92, 'dr_revenue',
    'ConnectedSolutions $200-400/kW-yr is the #1 revenue driver. G-3 Large General Service rate class.',
  ],
  [
    'Connecticut Light and Power Co', 'CT', 'ISO-NE',
    'ConnectedSolutions', 'daily-dispatch', 275, 'Jun 1', 'Sep 30', 60,
    'Through participating vendor', 'CT ESS Incentive', 0, 'N/A', 0, 1,
    'Connecticut Green Bank', '["statewide"]', 'ISO-NE SIR', 6, 1, 2, 0, 88,
    'dr_revenue',
    'CT Green Bank is the most mature C-PACE program in US ($400M+ deployed). Rate 56 General Service.',
  ],
  [
    'Oncor Electric Delivery Co LLC', 'TX', 'ERCOT',
    'None (deregulated)', 'N/A', 0, 'N/A', 'N/A', 0, 'N/A',
    'None (federal ITC only)', 0, 'N/A', 0, 1, 'Lone Star PACE',
    '["Dallas","Fort Worth","Arlington","Plano","Irving","Denton"]',
    'ERCOT BTM interconnection', 4, 0, 2, 0, 78, '4cp',
    '4CP transmission charges are the entire game. $8-15/kW x 4 summer months. No state incentive.',
  ],
];

const seedMany = db.transaction(() => {
  for (const row of data) {
    insert.run(...row);
  }
});

seedMany();
console.log(`Seeded ${data.length} enrichment records.`);
db.close();
