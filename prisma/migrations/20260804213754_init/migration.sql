-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "eligibility_kind" AS ENUM ('STANDARD', 'PRIORITY', 'INELIGIBLE');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('LEAD', 'SUBMITTED', 'RENTER_PENDING', 'SURVEY_SCHEDULED', 'SIGNED');

-- CreateEnum
CREATE TYPE "owner_outreach_mode" AS ENUM ('WE', 'SELF');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "firebase_uid" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255),
    "role" "user_role" NOT NULL DEFAULT 'ADMIN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" SERIAL NOT NULL,
    "application_number" VARCHAR(32) NOT NULL,
    "status" "application_status" NOT NULL DEFAULT 'SUBMITTED',
    "source" VARCHAR(64),
    "first_name" VARCHAR(120) NOT NULL,
    "last_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(40) NOT NULL,
    "preferred_language" VARCHAR(60),
    "formatted_address" VARCHAR(400) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "city" VARCHAR(120),
    "utility" VARCHAR(160),
    "dwelling_type" VARCHAR(80),
    "is_owner" BOOLEAN NOT NULL DEFAULT true,
    "utility_account" VARCHAR(60),
    "has_medical_equipment" BOOLEAN NOT NULL DEFAULT false,
    "eligibility_kind" "eligibility_kind",
    "resolved_utility" VARCHAR(160),
    "resolved_city" VARCHAR(120),
    "install_location" VARCHAR(80),
    "panel_amps" VARCHAR(80),
    "panel_age" VARCHAR(80),
    "solar_status" VARCHAR(120),
    "access_notes" VARCHAR(1000),
    "owner_name" VARCHAR(200),
    "owner_org" VARCHAR(200),
    "owner_email" VARCHAR(255),
    "owner_phone" VARCHAR(40),
    "owner_outreach_mode" "owner_outreach_mode",
    "owner_note" VARCHAR(1000),
    "renter_pending_consent" BOOLEAN NOT NULL DEFAULT false,
    "survey_date" VARCHAR(40),
    "survey_slot" VARCHAR(40),
    "agree_read_esa" BOOLEAN NOT NULL DEFAULT false,
    "agree_auth_enroll" BOOLEAN NOT NULL DEFAULT false,
    "agree_esign" BOOLEAN NOT NULL DEFAULT false,
    "signed_name" VARCHAR(200),
    "signed_at" TIMESTAMP(3),
    "esa_version" VARCHAR(40),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_tariffs" (
    "id" SERIAL NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "utility_name" VARCHAR(255) NOT NULL,
    "eia_id" VARCHAR(32),
    "rate_name" VARCHAR(400),
    "sector" VARCHAR(64),
    "service_type" VARCHAR(120),
    "description" TEXT,
    "source_url" VARCHAR(600),
    "is_default" BOOLEAN,
    "approved" BOOLEAN,
    "start_date" VARCHAR(40),
    "end_date" VARCHAR(40),
    "flat_demand_unit" VARCHAR(40),
    "flat_demand_structure" JSONB,
    "flat_demand_months" JSONB,
    "demand_rate_unit" VARCHAR(40),
    "demand_rate_structure" JSONB,
    "demand_weekday_schedule" JSONB,
    "demand_weekend_schedule" JSONB,
    "demand_ratchet_percentage" DOUBLE PRECISION,
    "demand_window" INTEGER,
    "demand_reactive_power_charge" DOUBLE PRECISION,
    "coincident_rate_unit" VARCHAR(40),
    "coincident_rate_structure" JSONB,
    "coincident_schedule" JSONB,
    "energy_rate_unit" VARCHAR(40),
    "energy_rate_structure" JSONB,
    "energy_weekday_schedule" JSONB,
    "energy_weekend_schedule" JSONB,
    "fixed_monthly_charge" DOUBLE PRECISION,
    "min_monthly_charge" DOUBLE PRECISION,
    "annual_min_charge" DOUBLE PRECISION,
    "peak_kw_capacity_min" DOUBLE PRECISION,
    "peak_kw_capacity_max" DOUBLE PRECISION,
    "uses_net_metering" BOOLEAN,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_enrichment" (
    "id" SERIAL NOT NULL,
    "utility_name" VARCHAR(255) NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "iso_rto" VARCHAR(40),
    "dr_program_name" VARCHAR(200),
    "dr_program_type" VARCHAR(120),
    "dr_revenue_per_kw_year" DOUBLE PRECISION,
    "dr_season_start" VARCHAR(40),
    "dr_season_end" VARCHAR(40),
    "dr_events_per_year" INTEGER,
    "dr_enrollment_method" VARCHAR(200),
    "incentive_program" VARCHAR(200),
    "incentive_rate_per_kwh" DOUBLE PRECISION,
    "incentive_block_name" VARCHAR(120),
    "incentive_remaining_mwh" DOUBLE PRECISION,
    "incentive_url" VARCHAR(600),
    "cpace_available" BOOLEAN,
    "cpace_administrator" VARCHAR(200),
    "cpace_administrator_contact" VARCHAR(200),
    "cpace_counties_opted_in" VARCHAR(600),
    "interconnection_process" VARCHAR(300),
    "interconnection_timeline_weeks" INTEGER,
    "green_button_cmd_available" BOOLEAN,
    "avg_permit_timeline_weeks" INTEGER,
    "fire_review_required" BOOLEAN,
    "specialRequirements" TEXT,
    "bess_score" INTEGER,
    "primary_revenue_driver" VARCHAR(60),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "utility_enrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "applications_application_number_key" ON "applications"("application_number");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE INDEX "applications_email_idx" ON "applications"("email");

-- CreateIndex
CREATE INDEX "applications_created_at_idx" ON "applications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rate_tariffs_label_key" ON "rate_tariffs"("label");

-- CreateIndex
CREATE INDEX "rate_tariffs_utility_name_idx" ON "rate_tariffs"("utility_name");

-- CreateIndex
CREATE INDEX "rate_tariffs_eia_id_idx" ON "rate_tariffs"("eia_id");

-- CreateIndex
CREATE INDEX "rate_tariffs_sector_idx" ON "rate_tariffs"("sector");

-- CreateIndex
CREATE INDEX "utility_enrichment_utility_name_idx" ON "utility_enrichment"("utility_name");

-- CreateIndex
CREATE INDEX "utility_enrichment_state_idx" ON "utility_enrichment"("state");

-- CreateIndex
CREATE UNIQUE INDEX "utility_enrichment_utility_name_state_key" ON "utility_enrichment"("utility_name", "state");
