/**
 * BESS savings model. Given site + rate inputs, sizes a battery and estimates
 * eight annual value streams, cost/incentive stack, C-PACE financing, and a
 * 0–100 composite score. Heuristic (not a full production-cost simulation) but
 * internally consistent; every constant is named and documented.
 */

export interface AnalyzeInput {
  peak_demand_kw: number;
  monthly_bill: number;
  facility_type: string;
  demand_charge_per_kw: number; // $/kW-month (combined supply + delivery)
  tou_spread_per_kwh: number; // $/kWh on-peak minus off-peak
  dr_revenue_per_kw_year: number; // $/kW-yr
  incentive_per_kwh: number; // $/kWh upfront state incentive
  ratchet_percentage: number; // 0–100
  utility_name?: string;
}

// ---- Model constants --------------------------------------------------------
const SHAVE_FRACTION = 0.3; // battery power sized to shave ~30% of peak
const INSTALLED_COST_PER_KWH = 700; // $/kWh turnkey C&I install (LFP, 2026)
const ITC_RATE = 0.3; // federal investment tax credit
const CORP_TAX_RATE = 0.21; // MACRS depreciation benefit rate
const MACRS_YEARS = 5;
const CYCLES_PER_YEAR = 300;
const ROUNDTRIP_EFF = 0.85;
const DEMAND_EFFECTIVENESS = 0.9; // fraction of nameplate peak reliably shaved
const SUPPLY_SHARE = 0.6; // split of combined demand charge → supply
const CP_VALUE_PER_KW = 35; // coincident-peak/transmission tag $/kW-yr
const RATCHET_MONTHS = 3; // months a ratchet would otherwise bind
const CPACE_RATE = 0.06;
const CPACE_TERM_YEARS = 20;

// Duration (hours) and annual resilience value ($/yr avoided outage) by facility.
const DURATION_HRS: Record<string, number> = {
  cold_storage: 4,
  healthcare: 4,
  manufacturing: 4,
  grocery: 2,
  hotel: 2,
  warehouse: 2,
  retail: 2,
  office: 2,
};
const RESILIENCE_VALUE: Record<string, number> = {
  healthcare: 28000,
  cold_storage: 22000,
  grocery: 16000,
  manufacturing: 14000,
  hotel: 9000,
  warehouse: 6000,
  retail: 5000,
  office: 4000,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function analyze(input: AnalyzeInput) {
  const {
    peak_demand_kw,
    facility_type,
    demand_charge_per_kw,
    tou_spread_per_kwh,
    dr_revenue_per_kw_year,
    incentive_per_kwh,
    ratchet_percentage,
  } = input;

  // ---- Sizing ---------------------------------------------------------------
  const rawKw = peak_demand_kw * SHAVE_FRACTION;
  const recommended_kw = Math.max(5, Math.round(rawKw / 5) * 5);
  const duration_hrs = DURATION_HRS[facility_type] ?? 2;
  const recommended_kwh = Math.round(recommended_kw * duration_hrs);

  // ---- Cost & incentive stack ----------------------------------------------
  const gross_cost = Math.round(recommended_kwh * INSTALLED_COST_PER_KWH);
  const incentive_amount = Math.min(
    Math.round(recommended_kwh * incentive_per_kwh),
    Math.round(gross_cost * 0.5), // cap state incentive at 50% of gross
  );
  const itc_amount = Math.round(gross_cost * ITC_RATE);
  const net_cost = Math.max(0, gross_cost - incentive_amount - itc_amount);

  // ---- Eight annual value streams ------------------------------------------
  const shaveKw = recommended_kw * DEMAND_EFFECTIVENESS;
  const demand_supply_savings = Math.round(
    shaveKw * (demand_charge_per_kw * SUPPLY_SHARE) * 12,
  );
  const demand_delivery_savings = Math.round(
    shaveKw * (demand_charge_per_kw * (1 - SUPPLY_SHARE)) * 12,
  );
  const tou_arbitrage_savings = Math.round(
    recommended_kwh * tou_spread_per_kwh * CYCLES_PER_YEAR * ROUNDTRIP_EFF,
  );
  const dr_revenue = Math.round(recommended_kw * dr_revenue_per_kw_year);
  const ratchet_avoidance_savings =
    ratchet_percentage > 0
      ? Math.round(
          shaveKw * demand_charge_per_kw * (ratchet_percentage / 100) * RATCHET_MONTHS,
        )
      : 0;
  const coincident_peak_savings = Math.round(recommended_kw * CP_VALUE_PER_KW);
  const resilience_value = RESILIENCE_VALUE[facility_type] ?? 5000;
  const depreciable_basis = gross_cost - itc_amount * 0.5; // MACRS basis reduced by half ITC
  const tax_benefit_value = Math.round((depreciable_basis * CORP_TAX_RATE) / MACRS_YEARS);

  const total_annual_savings =
    demand_supply_savings +
    demand_delivery_savings +
    tou_arbitrage_savings +
    dr_revenue +
    ratchet_avoidance_savings +
    coincident_peak_savings +
    resilience_value +
    tax_benefit_value;

  // ---- C-PACE financing -----------------------------------------------------
  const r = CPACE_RATE;
  const n = CPACE_TERM_YEARS;
  const cpace_annual_payment =
    net_cost > 0
      ? Math.round((net_cost * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1))
      : 0;
  const net_annual_cashflow = total_annual_savings - cpace_annual_payment;
  const simple_payback_years =
    total_annual_savings > 0
      ? Math.round((net_cost / total_annual_savings) * 10) / 10
      : 99;

  // ---- Composite score (0–100) ---------------------------------------------
  const paybackScore = clamp(100 - simple_payback_years * 15, 0, 100);
  const cashflowScore = net_annual_cashflow > 0 ? 100 : 40;
  const roi = net_cost > 0 ? total_annual_savings / net_cost : 1;
  const roiScore = clamp(roi * 150, 0, 100);
  const composite_score = Math.round(
    0.5 * paybackScore + 0.3 * cashflowScore + 0.2 * roiScore,
  );

  return {
    system: { recommended_kw, recommended_kwh, duration_hrs },
    costs: { gross_cost, incentive_amount, itc_amount, net_cost },
    savings: {
      demand_supply_savings,
      demand_delivery_savings,
      tou_arbitrage_savings,
      dr_revenue,
      ratchet_avoidance_savings,
      coincident_peak_savings,
      resilience_value,
      tax_benefit_value,
      total_annual_savings,
    },
    financing: { cpace_annual_payment, net_annual_cashflow, simple_payback_years },
    composite_score,
  };
}
