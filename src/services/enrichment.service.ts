/**
 * Utility enrichment lookups + response shaping. The frontend cards
 * (EnrichmentCard, IncentivesCard) expect snake_case shapes, so shapers here
 * translate Prisma's camelCase rows to the contract the web app already consumes.
 */
import type { UtilityEnrichment } from '@prisma/client';
import prisma from '../config/database';

/** Parse the stored counties string (JSON array or delimited) into an array. */
export function parseCounties(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    /* fall through to delimiter split */
  }
  return s
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Best-effort match: exact utility name, then a loose contains on the first token. */
export async function getEnrichmentByUtility(
  utilityName: string,
): Promise<UtilityEnrichment | null> {
  const exact = await prisma.utilityEnrichment.findFirst({ where: { utilityName } });
  if (exact) return exact;
  const token = utilityName.split(/\s+/)[0];
  if (!token) return null;
  return prisma.utilityEnrichment.findFirst({
    where: { utilityName: { contains: token, mode: 'insensitive' } },
  });
}

/** EnrichmentCard shape (snake_case). */
export function shapeEnrichment(row: UtilityEnrichment | null) {
  if (!row) return null;
  return {
    utility_name: row.utilityName,
    state: row.state,
    iso_rto: row.isoRto,
    dr_program_name: row.drProgramName,
    dr_program_type: row.drProgramType,
    dr_revenue_per_kw_year: row.drRevenuePerKwYear,
    dr_season_start: row.drSeasonStart,
    dr_season_end: row.drSeasonEnd,
    dr_events_per_year: row.drEventsPerYear,
    dr_enrollment_method: row.drEnrollmentMethod,
    incentive_program: row.incentiveProgram,
    incentive_rate_per_kwh: row.incentiveRatePerKwh,
    incentive_block_name: row.incentiveBlockName,
    incentive_remaining_mwh: row.incentiveRemainingMwh,
    cpace_available: !!row.cpaceAvailable,
    cpace_administrator: row.cpaceAdministrator,
    cpace_counties_opted_in: parseCounties(row.cpaceCountiesOptedIn),
    interconnection_process: row.interconnectionProcess,
    interconnection_timeline_weeks: row.interconnectionTimelineWeeks,
    green_button_cmd_available: !!row.greenButtonCmdAvailable,
    avg_permit_timeline_weeks: row.avgPermitTimelineWeeks,
    fire_review_required: !!row.fireReviewRequired,
    bess_score: row.bessScore,
    primary_revenue_driver: row.primaryRevenueDriver,
    notes: row.notes,
  };
}

/** IncentivesCard shape: derive incentive rows from enrichment. */
export function shapeIncentives(row: UtilityEnrichment | null) {
  if (!row) return [];
  const out: {
    incentive_name: string;
    incentive_page: string;
    incentive_type: string;
    incentive_descr: string;
  }[] = [];
  if (row.incentiveProgram && row.incentiveProgram !== 'None (federal ITC only)') {
    out.push({
      incentive_name: row.incentiveProgram,
      incentive_page: row.incentiveUrl || '',
      incentive_type: 'Storage incentive',
      incentive_descr:
        row.incentiveRatePerKwh && row.incentiveRatePerKwh > 0
          ? `${row.incentiveRatePerKwh} $/kWh (${row.incentiveBlockName ?? 'current block'})`
          : row.incentiveBlockName || 'See program page for current rates.',
    });
  }
  if (row.drProgramName && row.drProgramName !== 'None (deregulated)') {
    out.push({
      incentive_name: row.drProgramName,
      incentive_page: '',
      incentive_type: 'Demand response',
      incentive_descr:
        row.drRevenuePerKwYear && row.drRevenuePerKwYear > 0
          ? `~${row.drRevenuePerKwYear} $/kW-yr (${row.drProgramType ?? 'program'})`
          : row.drProgramType || 'Demand response program.',
    });
  }
  return out;
}
