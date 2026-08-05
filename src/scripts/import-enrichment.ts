/**
 * Seeds UtilityEnrichment with curated market data for the target utility
 * territories. Idempotent: upserts on (utilityName, state).
 * Run: npm run import:enrichment
 */
import prisma from '../config/database';

type EnrichmentSeed = {
  utilityName: string;
  state: string;
  isoRto: string;
  drProgramName: string;
  drProgramType: string;
  drRevenuePerKwYear: number;
  drSeasonStart: string;
  drSeasonEnd: string;
  drEventsPerYear: number;
  drEnrollmentMethod: string;
  incentiveProgram: string;
  incentiveRatePerKwh: number;
  incentiveBlockName: string;
  incentiveRemainingMwh: number;
  cpaceAvailable: boolean;
  cpaceAdministrator: string;
  cpaceCountiesOptedIn: string; // JSON array string, e.g. '["Nassau","Suffolk"]'
  interconnectionProcess: string;
  interconnectionTimelineWeeks: number;
  greenButtonCmdAvailable: boolean;
  avgPermitTimelineWeeks: number;
  fireReviewRequired: boolean;
  bessScore: number;
  primaryRevenueDriver: string;
  notes: string;
};

const DATA: EnrichmentSeed[] = [
  {
    utilityName: 'Consolidated Edison Co-NY Inc',
    state: 'NY',
    isoRto: 'NYISO',
    drProgramName: 'CSRP + DLRP (Rider T)',
    drProgramType: 'event-based',
    drRevenuePerKwYear: 300,
    drSeasonStart: 'May 1',
    drSeasonEnd: 'Sep 30',
    drEventsPerYear: 10,
    drEnrollmentMethod: 'Aggregator (Rider T registration required)',
    incentiveProgram: 'NYSERDA Retail Storage',
    incentiveRatePerKwh: 175,
    incentiveBlockName: 'ROS-5',
    incentiveRemainingMwh: 256,
    cpaceAvailable: true,
    cpaceAdministrator: 'EIC Open C-PACE (suburbs) / NYCEEC (NYC)',
    cpaceCountiesOptedIn: '["Westchester","Nassau","Rockland","NYC"]',
    interconnectionProcess: 'ConEd CESIR (>300kW) or SIR (<300kW)',
    interconnectionTimelineWeeks: 8,
    greenButtonCmdAvailable: true,
    avgPermitTimelineWeeks: 3,
    fireReviewRequired: false,
    bessScore: 95,
    primaryRevenueDriver: 'demand_charges',
    notes:
      'SC9 Rate II primary target. Combined demand $34.30/kW. Westchester suburbs preferred over NYC (no FDNY T-90).',
  },
  {
    utilityName: 'PSEG Long Island',
    state: 'NY',
    isoRto: 'NYISO',
    drProgramName: 'Dynamic Load Management + Battery Storage Rewards',
    drProgramType: 'event-based',
    drRevenuePerKwYear: 200,
    drSeasonStart: 'May 1',
    drSeasonEnd: 'Sep 30',
    drEventsPerYear: 8,
    drEnrollmentMethod: 'Direct enrollment with PSEG LI',
    incentiveProgram: 'NYSERDA Retail Storage',
    incentiveRatePerKwh: 175,
    incentiveBlockName: 'ROS-5',
    incentiveRemainingMwh: 256,
    cpaceAvailable: true,
    cpaceAdministrator: 'EIC Open C-PACE',
    cpaceCountiesOptedIn: '["Nassau","Suffolk"]',
    interconnectionProcess: 'LIPA SIR',
    interconnectionTimelineWeeks: 6,
    greenButtonCmdAvailable: false,
    avgPermitTimelineWeeks: 3,
    fireReviewRequired: false,
    bessScore: 80,
    primaryRevenueDriver: 'demand_charges',
    notes:
      'LIPA Rate 281 for large commercial. Lower demand charges than ConEd ($12-25/kW). Green Button limited.',
  },
  {
    utilityName: 'NSTAR Electric Company',
    state: 'MA',
    isoRto: 'ISO-NE',
    drProgramName: 'ConnectedSolutions',
    drProgramType: 'daily-dispatch',
    drRevenuePerKwYear: 350,
    drSeasonStart: 'Jun 1',
    drSeasonEnd: 'Sep 30',
    drEventsPerYear: 60,
    drEnrollmentMethod: 'Through participating vendor (CT Battery Solutions)',
    incentiveProgram: 'MA SMART Storage Adder',
    incentiveRatePerKwh: 0,
    incentiveBlockName: 'N/A',
    incentiveRemainingMwh: 0,
    cpaceAvailable: true,
    cpaceAdministrator: 'MassDevelopment',
    cpaceCountiesOptedIn: '["statewide"]',
    interconnectionProcess: 'ISO-NE SIR',
    interconnectionTimelineWeeks: 6,
    greenButtonCmdAvailable: true,
    avgPermitTimelineWeeks: 2,
    fireReviewRequired: false,
    bessScore: 92,
    primaryRevenueDriver: 'dr_revenue',
    notes:
      'ConnectedSolutions $200-400/kW-yr is the #1 revenue driver. G-3 Large General Service rate class.',
  },
  {
    utilityName: 'Connecticut Light and Power Co',
    state: 'CT',
    isoRto: 'ISO-NE',
    drProgramName: 'ConnectedSolutions',
    drProgramType: 'daily-dispatch',
    drRevenuePerKwYear: 275,
    drSeasonStart: 'Jun 1',
    drSeasonEnd: 'Sep 30',
    drEventsPerYear: 60,
    drEnrollmentMethod: 'Through participating vendor',
    incentiveProgram: 'CT ESS Incentive',
    incentiveRatePerKwh: 0,
    incentiveBlockName: 'N/A',
    incentiveRemainingMwh: 0,
    cpaceAvailable: true,
    cpaceAdministrator: 'Connecticut Green Bank',
    cpaceCountiesOptedIn: '["statewide"]',
    interconnectionProcess: 'ISO-NE SIR',
    interconnectionTimelineWeeks: 6,
    greenButtonCmdAvailable: true,
    avgPermitTimelineWeeks: 2,
    fireReviewRequired: false,
    bessScore: 88,
    primaryRevenueDriver: 'dr_revenue',
    notes:
      'CT Green Bank is the most mature C-PACE program in US ($400M+ deployed). Rate 56 General Service.',
  },
  {
    utilityName: 'Oncor Electric Delivery Co LLC',
    state: 'TX',
    isoRto: 'ERCOT',
    drProgramName: 'None (deregulated)',
    drProgramType: 'N/A',
    drRevenuePerKwYear: 0,
    drSeasonStart: 'N/A',
    drSeasonEnd: 'N/A',
    drEventsPerYear: 0,
    drEnrollmentMethod: 'N/A',
    incentiveProgram: 'None (federal ITC only)',
    incentiveRatePerKwh: 0,
    incentiveBlockName: 'N/A',
    incentiveRemainingMwh: 0,
    cpaceAvailable: true,
    cpaceAdministrator: 'Lone Star PACE',
    cpaceCountiesOptedIn:
      '["Dallas","Fort Worth","Arlington","Plano","Irving","Denton"]',
    interconnectionProcess: 'ERCOT BTM interconnection',
    interconnectionTimelineWeeks: 4,
    greenButtonCmdAvailable: false,
    avgPermitTimelineWeeks: 2,
    fireReviewRequired: false,
    bessScore: 78,
    primaryRevenueDriver: '4cp',
    notes:
      '4CP transmission charges are the entire game. $8-15/kW x 4 summer months. No state incentive.',
  },
];

async function main() {
  for (const row of DATA) {
    await prisma.utilityEnrichment.upsert({
      where: { utilityName_state: { utilityName: row.utilityName, state: row.state } },
      create: row,
      update: row,
    });
  }
  const count = await prisma.utilityEnrichment.count();
  console.log(`Seeded enrichment. Total rows: ${count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
