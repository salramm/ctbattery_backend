-- ============================================================================
-- LIFECYCLE DATA FOUNDATION (P1) — re-model, not additive (R2).
-- One `systems` spine replaces the four-table conversion spine
-- (SalesLead → Customer → Project → BatteryAsset). The `~`-partial tables are
-- reshaped IN PLACE (addresses→properties, battery_assets→equipment,
-- contractors→installers, stage_transitions→stage_history, documents, alerts,
-- work_orders). Demo spine rows are retained and BACKFILLED into `systems`.
-- Every non-additive statement is marked `-- NON-ADDITIVE` and logged in
-- docs/lifecycle/ROLLOUT-NOTES.md.
-- ============================================================================

-- ========================= PHASE 1 — new enum types =========================
CREATE TYPE "stage" AS ENUM ('S01_LEAD', 'S02_QUALIFIED', 'S03_COMMITTED', 'S04_APPLIED', 'S05_ENTITLED', 'S06_SCHEDULED', 'S07_INSTALLED', 'S08_COMMISSIONED', 'S09_LIVE', 'OPERATING');
CREATE TYPE "terminal_state" AS ENUM ('DISQUALIFIED', 'WITHDRAWN', 'EXPIRED', 'REMOVED', 'TERM_COMPLETE');
CREATE TYPE "health" AS ENUM ('OK', 'WATCH', 'FAULT', 'SERVICE');
CREATE TYPE "flag" AS ENUM ('TURNOVER', 'WARRANTY');
CREATE TYPE "tier" AS ENUM ('LI', 'UNDERSERVED', 'STANDARD');
CREATE TYPE "connection" AS ENUM ('M1', 'M2', 'M3', 'M4', 'M5');
CREATE TYPE "account_type" AS ENUM ('HA', 'OWNER', 'CAA', 'CBO', 'INDIVIDUAL');
CREATE TYPE "deal_state" AS ENUM ('D1_TARGET', 'D2_ENGAGED', 'D3_PRESENTED', 'D4_PILOT', 'D5_MASTER', 'D6_RELEASING', 'D7_EXPANSION');
CREATE TYPE "checklist_state" AS ENUM ('OPEN', 'NA', 'DONE');
CREATE TYPE "history_via" AS ENUM ('AUTO', 'MANUAL', 'OVERRIDE');
CREATE TYPE "doc_type" AS ENUM ('ESA', 'TC', 'PAYEE_DESIGNATION', 'MASTER_AGMT', 'PERMIT', 'IX_APPROVAL', 'SELF_INSPECTION', 'ROF_LETTER', 'COF_LETTER', 'APPENDIX_E', 'ATTESTATION', 'PHOTO', 'STATEMENT', 'OTHER');
CREATE TYPE "doc_status" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'VOID');
CREATE TYPE "equip_kind" AS ENUM ('BATTERY', 'COMBINER', 'COLLAR', 'GATEWAY');
CREATE TYPE "equip_status" AS ENUM ('IN_STOCK', 'ALLOCATED', 'INSTALLED', 'RMA_OUT', 'RETIRED');
CREATE TYPE "wo_type" AS ENUM ('INSTALL', 'SERVICE', 'INSPECTION', 'TURNOVER');
CREATE TYPE "wo_status" AS ENUM ('DRAFT', 'SCHEDULED', 'CHECKED_IN', 'COMPLETE', 'CANCELLED');
CREATE TYPE "alert_severity" AS ENUM ('WATCH', 'FAULT');
CREATE TYPE "ticket_state" AS ENUM ('NEW', 'TRIAGED', 'REMOTE_ATTEMPTED', 'FIELD_NEEDED', 'SCHEDULED', 'ON_SITE', 'RESOLVED', 'VERIFIED', 'CLOSED');
CREATE TYPE "ticket_category" AS ENUM ('COMMS', 'HARDWARE', 'PERFORMANCE', 'PHYSICAL', 'RESIDENT');
CREATE TYPE "resolution_code" AS ENUM ('REMOTE_FIX', 'HARDWARE_RMA', 'WIRING', 'RESIDENT_ACTION', 'NO_FAULT');
CREATE TYPE "ledger_type" AS ENUM ('ENROLL_INC', 'PERF_PAY', 'ITC_CASH', 'OPEX', 'SERVICE_COST');
CREATE TYPE "ledger_status" AS ENUM ('EXPECTED', 'RECEIVED', 'VARIANCE');
CREATE TYPE "season_status" AS ENUM ('OPEN', 'CLOSED', 'RECONCILED');
CREATE TYPE "claim_status" AS ENUM ('ACCRUING', 'BASIS_LOCKED', 'EVIDENCE_COMPLETE', 'IN_COHORT', 'TRANSFERRED');
CREATE TYPE "cohort_status" AS ENUM ('ASSEMBLING', 'LISTED', 'TERM_SHEET', 'DILIGENCE', 'EXECUTED', 'CASH_RECEIVED');
CREATE TYPE "basis_source" AS ENUM ('PO', 'WO', 'PERMIT', 'OVERHEAD');
CREATE TYPE "alloc_category" AS ENUM ('CAT1', 'CAT3');
CREATE TYPE "event_source" AS ENUM ('ENERGYHUB_CSV', 'ENLIGHTEN_XCHECK', 'MANUAL');
CREATE TYPE "role" AS ENUM ('ADMIN', 'OPS', 'FIELD', 'VIEWER');
CREATE TYPE "po_status" AS ENUM ('DRAFT', 'ORDERED', 'RECEIVED', 'PARTIAL');

-- ================= PHASE 2 — drop obsolete FKs / indexes ====================
-- NON-ADDITIVE: staff/marketplace FKs dropped (platform_users + marketplace fall out of lifecycle scope).
ALTER TABLE "addresses"   DROP CONSTRAINT "addresses_ahjId_fkey";
ALTER TABLE "addresses"   DROP CONSTRAINT "addresses_utilityId_fkey";
ALTER TABLE "alerts"      DROP CONSTRAINT "alerts_monitoringSiteId_fkey";
ALTER TABLE "alerts"      DROP CONSTRAINT "alerts_projectId_fkey";
ALTER TABLE "alerts"      DROP CONSTRAINT "alerts_workOrderId_fkey";
ALTER TABLE "battery_assets" DROP CONSTRAINT "battery_assets_batteryModelId_fkey";
ALTER TABLE "battery_assets" DROP CONSTRAINT "battery_assets_projectId_fkey";
ALTER TABLE "bids"        DROP CONSTRAINT "bids_contractorId_fkey";        -- NON-ADDITIVE
ALTER TABLE "contacts"    DROP CONSTRAINT "contacts_userId_fkey";          -- NON-ADDITIVE
ALTER TABLE "contractor_users" DROP CONSTRAINT "contractor_users_contractorId_fkey";
ALTER TABLE "contractor_users" DROP CONSTRAINT "contractor_users_userId_fkey";
ALTER TABLE "documents"   DROP CONSTRAINT "documents_customerId_fkey";
ALTER TABLE "documents"   DROP CONSTRAINT "documents_projectId_fkey";
ALTER TABLE "projects"    DROP CONSTRAINT "projects_projectManagerId_fkey"; -- NON-ADDITIVE
ALTER TABLE "sales_leads" DROP CONSTRAINT "sales_leads_ownerId_fkey";       -- NON-ADDITIVE
ALTER TABLE "stage_transitions" DROP CONSTRAINT "stage_transitions_actorId_fkey";
ALTER TABLE "tasks"       DROP CONSTRAINT "tasks_assigneeId_fkey";          -- NON-ADDITIVE
ALTER TABLE "work_orders" DROP CONSTRAINT "work_orders_contractorId_fkey";
ALTER TABLE "work_orders" DROP CONSTRAINT "work_orders_jobPostingId_fkey";
ALTER TABLE "work_orders" DROP CONSTRAINT "work_orders_projectId_fkey";

DROP INDEX "alerts_projectId_idx";
DROP INDEX "alerts_severity_idx";
DROP INDEX "bids_jobPostingId_contractorId_key";                            -- NON-ADDITIVE
DROP INDEX "contacts_userId_key";
DROP INDEX "documents_projectId_idx";
DROP INDEX "work_orders_jobPostingId_key";
DROP INDEX "work_orders_projectId_idx";

-- ============ PHASE 3 — users consolidation (keep Firebase link, R6) ========
-- NON-ADDITIVE: firebase_uid relaxed to nullable (non-Firebase staff).
ALTER TABLE "users" ALTER COLUMN "firebase_uid" DROP NOT NULL;
-- NON-ADDITIVE: role user_role(ADMIN/OWNER) -> role(ADMIN/OPS/FIELD/VIEWER).
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "role" USING (CASE "role"::text WHEN 'OWNER' THEN 'ADMIN' ELSE 'ADMIN' END)::"role";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'ADMIN';
-- Fold platform_users staff into the single users table (role remap per GAP §2).
INSERT INTO "users" ("firebase_uid", "email", "name", "role", "created_at", "updated_at")
SELECT NULL, pu."email", pu."name",
  (CASE pu."role"::text
     WHEN 'CONTRACTOR' THEN 'FIELD'
     WHEN 'HOMEOWNER'  THEN 'VIEWER'
     WHEN 'ADMIN'      THEN 'ADMIN'
     WHEN 'OWNER'      THEN 'ADMIN'
     ELSE 'OPS' END)::"role",
  now(), now()
FROM "platform_users" pu
ON CONFLICT ("email") DO NOTHING;

-- ============ PHASE 4 — reshape addresses -> properties (in place) ==========
-- NON-ADDITIVE: table + column renames; drop line2; widen with lifecycle columns.
ALTER TABLE "addresses" RENAME TO "properties";
ALTER TABLE "properties" RENAME CONSTRAINT "addresses_pkey" TO "properties_pkey";
ALTER INDEX "addresses_county_idx" RENAME TO "properties_county_idx";
ALTER TABLE "properties" RENAME COLUMN "postalCode" TO "postal_code";
ALTER TABLE "properties" RENAME COLUMN "utilityId"  TO "utility_id";
ALTER TABLE "properties" RENAME COLUMN "ahjId"      TO "ahj_id";
ALTER TABLE "properties" RENAME COLUMN "createdAt"  TO "created_at";
ALTER TABLE "properties" RENAME COLUMN "updatedAt"  TO "updated_at";
ALTER TABLE "properties" DROP COLUMN "line2";        -- NON-ADDITIVE
ALTER TABLE "properties" ADD COLUMN "account_id" UUID;
ALTER TABLE "properties" ADD COLUMN "name" TEXT;
ALTER TABLE "properties" ADD COLUMN "master_agmt_doc_id" TEXT; -- documents.id is cuid (text)
ALTER TABLE "properties" ADD COLUMN "geo" JSONB;
ALTER TABLE "properties" ALTER COLUMN "city" DROP NOT NULL; -- town nullable per 01

-- ============ PHASE 5 — reshape contractors -> installers (in place) ========
-- NON-ADDITIVE: table rename + drop marketplace columns.
ALTER TABLE "contractors" RENAME TO "installers";
ALTER TABLE "installers" RENAME CONSTRAINT "contractors_pkey" TO "installers_pkey";
ALTER TABLE "installers" RENAME COLUMN "companyName" TO "org_name";
ALTER TABLE "installers" RENAME COLUMN "createdAt"  TO "created_at";
ALTER TABLE "installers" RENAME COLUMN "updatedAt"  TO "updated_at";
ALTER TABLE "installers" ADD COLUMN "self_perform" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "installers" ADD COLUMN "license_nos" JSONB;
ALTER TABLE "installers" ADD COLUMN "rates" JSONB;
UPDATE "installers" SET "license_nos" = to_jsonb(ARRAY["licenseNumber"]);
ALTER TABLE "installers" DROP COLUMN "licenseNumber";      -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "licenseExpiresAt";   -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "insuranceExpiresAt"; -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "serviceCounties";    -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "certifications";     -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "rating";             -- NON-ADDITIVE
ALTER TABLE "installers" DROP COLUMN "status";             -- NON-ADDITIVE

-- ============ PHASE 6 — reshape battery_assets -> equipment (in place) ======
-- NON-ADDITIVE: table rename, status value RMA->RMA_OUT, drop battery-only columns.
ALTER TABLE "battery_assets" RENAME TO "equipment";
ALTER TABLE "equipment" RENAME CONSTRAINT "battery_assets_pkey" TO "equipment_pkey";
ALTER INDEX "battery_assets_status_idx" RENAME TO "equipment_status_idx";
ALTER INDEX "battery_assets_serialNumber_key" RENAME TO "equipment_serial_key";
ALTER TABLE "equipment" RENAME COLUMN "serialNumber" TO "serial";
ALTER TABLE "equipment" RENAME COLUMN "installedAt"  TO "installed_at";
ALTER TABLE "equipment" RENAME COLUMN "createdAt"    TO "created_at";
ALTER TABLE "equipment" RENAME COLUMN "updatedAt"    TO "updated_at";
ALTER TABLE "equipment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "equipment" ALTER COLUMN "status" TYPE "equip_status"
  USING (CASE "status"::text WHEN 'RMA' THEN 'RMA_OUT' ELSE "status"::text END)::"equip_status"; -- NON-ADDITIVE
ALTER TABLE "equipment" ALTER COLUMN "status" SET DEFAULT 'IN_STOCK';
ALTER TABLE "equipment" ADD COLUMN "system_id" UUID;
ALTER TABLE "equipment" ADD COLUMN "kind" "equip_kind" NOT NULL DEFAULT 'BATTERY';
ALTER TABLE "equipment" ADD COLUMN "sku" TEXT;
ALTER TABLE "equipment" ADD COLUMN "dom" BOOLEAN;
ALTER TABLE "equipment" ADD COLUMN "attestation_doc_id" TEXT; -- documents.id is cuid (text)
ALTER TABLE "equipment" ADD COLUMN "fw" TEXT;
ALTER TABLE "equipment" ADD COLUMN "removed_at" TIMESTAMP(3);
ALTER TABLE "equipment" ADD COLUMN "replaced_by_id" TEXT;
ALTER TABLE "equipment" ADD COLUMN "rma_no" TEXT;
ALTER TABLE "equipment" ADD COLUMN "po_id" UUID;
-- batteryModelId / projectId / warrantyEndsAt kept until backfill (dropped in PHASE 12).

-- ============ PHASE 7 — reshape documents (in place) ========================
-- NON-ADDITIVE: rename fileUrl->file_key etc.; widen DocType; add system/property/account scope.
ALTER TABLE "documents" RENAME COLUMN "esignEnvelopeId" TO "envelope_id";
ALTER TABLE "documents" RENAME COLUMN "fileUrl"   TO "file_key";
ALTER TABLE "documents" RENAME COLUMN "signedAt"  TO "signed_at";
ALTER TABLE "documents" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "documents" RENAME COLUMN "updatedAt" TO "updated_at";
ALTER TABLE "documents" ALTER COLUMN "file_key" DROP NOT NULL; -- NON-ADDITIVE (stock/unfiled docs)
ALTER TABLE "documents" ADD COLUMN "system_id" UUID;
ALTER TABLE "documents" ADD COLUMN "property_id" TEXT;
ALTER TABLE "documents" ADD COLUMN "account_id" UUID;
ALTER TABLE "documents" ADD COLUMN "title" TEXT;
ALTER TABLE "documents" ADD COLUMN "uploaded_by" TEXT;
ALTER TABLE "documents" ALTER COLUMN "type" TYPE "doc_type"
  USING (CASE "type"::text
    WHEN 'PERMIT_SET' THEN 'PERMIT'
    WHEN 'INSPECTION_REPORT' THEN 'SELF_INSPECTION'
    WHEN 'TPO_AGREEMENT' THEN 'MASTER_AGMT'
    WHEN 'PHOTO' THEN 'PHOTO'
    ELSE 'OTHER' END)::"doc_type"; -- NON-ADDITIVE
ALTER TABLE "documents" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "documents" ALTER COLUMN "status" TYPE "doc_status" USING "status"::text::"doc_status";
ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
-- customerId / projectId kept until backfill (dropped in PHASE 12).

-- ============ PHASE 8 — reshape alerts (in place) ===========================
-- NON-ADDITIVE: retarget to system_id, severity Severity->alert_severity, fold legacy code/message into context.
ALTER TABLE "alerts" RENAME COLUMN "openedAt"   TO "opened_at";
ALTER TABLE "alerts" RENAME COLUMN "resolvedAt" TO "cleared_at";
ALTER TABLE "alerts" RENAME COLUMN "createdAt"  TO "created_at";
ALTER TABLE "alerts" RENAME COLUMN "updatedAt"  TO "updated_at";
ALTER TABLE "alerts" ALTER COLUMN "severity" DROP DEFAULT;
ALTER TABLE "alerts" ALTER COLUMN "severity" TYPE "alert_severity"
  USING (CASE "severity"::text WHEN 'CRITICAL' THEN 'FAULT' ELSE 'WATCH' END)::"alert_severity"; -- NON-ADDITIVE
ALTER TABLE "alerts" ALTER COLUMN "severity" SET DEFAULT 'WATCH';
ALTER TABLE "alerts" ADD COLUMN "system_id" UUID; -- filled in backfill, set NOT NULL in PHASE 12
ALTER TABLE "alerts" ADD COLUMN "rule_key" TEXT;
ALTER TABLE "alerts" ADD COLUMN "context" JSONB;
ALTER TABLE "alerts" ADD COLUMN "ticket_id" UUID;
UPDATE "alerts" SET "context" = jsonb_build_object('legacy_code', "code", 'message', "message", 'monitoring_site_id', "monitoringSiteId");
-- projectId / monitoringSiteId / code / message / acknowledgedAt / workOrderId kept until backfill.

-- ============ PHASE 9 — reshape work_orders (in place) ======================
-- NON-ADDITIVE: crew-scheduled shape; relax jobPostingId; WorkOrderStatus->wo_status; JobScope->wo_type.
ALTER TABLE "work_orders" RENAME COLUMN "jobPostingId" TO "job_posting_id";
ALTER TABLE "work_orders" RENAME COLUMN "scheduledAt"  TO "date";
ALTER TABLE "work_orders" RENAME COLUMN "createdAt"    TO "created_at";
ALTER TABLE "work_orders" RENAME COLUMN "updatedAt"    TO "updated_at";
ALTER TABLE "work_orders" ALTER COLUMN "job_posting_id" DROP NOT NULL; -- NON-ADDITIVE (GAP §5.5)
ALTER TABLE "work_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "work_orders" ALTER COLUMN "status" TYPE "wo_status"
  USING (CASE "status"::text
    WHEN 'SCHEDULED' THEN 'SCHEDULED'
    WHEN 'CANCELLED' THEN 'CANCELLED'
    WHEN 'IN_PROGRESS' THEN 'CHECKED_IN'
    WHEN 'SUBMITTED' THEN 'COMPLETE'
    WHEN 'ACCEPTED' THEN 'COMPLETE'
    WHEN 'REWORK' THEN 'SCHEDULED'
    ELSE 'DRAFT' END)::"wo_status"; -- NON-ADDITIVE
ALTER TABLE "work_orders" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "work_orders" ADD COLUMN "type" "wo_type" NOT NULL DEFAULT 'INSTALL';
UPDATE "work_orders" SET "type" = (CASE "scope"::text
    WHEN 'INSTALL' THEN 'INSTALL'
    WHEN 'SERVICE' THEN 'SERVICE'
    WHEN 'REMOVAL' THEN 'SERVICE'
    ELSE 'INSPECTION' END)::"wo_type";
ALTER TABLE "work_orders" ADD COLUMN "system_id" UUID;
ALTER TABLE "work_orders" ADD COLUMN "crew_id" UUID;
ALTER TABLE "work_orders" ADD COLUMN "route_group" TEXT;
ALTER TABLE "work_orders" ADD COLUMN "photos" JSONB;
ALTER TABLE "work_orders" ADD COLUMN "checkin_at" TIMESTAMP(3);
ALTER TABLE "work_orders" ADD COLUMN "checkout_at" TIMESTAMP(3);
ALTER TABLE "work_orders" ADD COLUMN "ticket_id" UUID;
ALTER TABLE "work_orders" DROP COLUMN "scope";        -- NON-ADDITIVE
ALTER TABLE "work_orders" DROP COLUMN "completedAt";  -- NON-ADDITIVE
ALTER TABLE "work_orders" DROP COLUMN "qualityScore"; -- NON-ADDITIVE
-- projectId / contractorId kept until backfill (dropped in PHASE 12).

-- ============ PHASE 10 — reshape stage_transitions -> stage_history =========
-- NON-ADDITIVE: append-only history constrained to systems; demo rows cleared (polymorphic, string stages).
DELETE FROM "stage_transitions"; -- NON-ADDITIVE (demo rows; free-string stages cannot map to the enum)
ALTER TABLE "stage_transitions" RENAME TO "stage_history";
ALTER TABLE "stage_history" RENAME CONSTRAINT "stage_transitions_pkey" TO "stage_history_pkey";
DROP INDEX "stage_transitions_subjectType_subjectId_idx";
ALTER TABLE "stage_history" RENAME COLUMN "occurredAt" TO "at";
ALTER TABLE "stage_history" RENAME COLUMN "actorId"    TO "by";
ALTER TABLE "stage_history" DROP COLUMN "subjectType"; -- NON-ADDITIVE
ALTER TABLE "stage_history" DROP COLUMN "subjectId";   -- NON-ADDITIVE
ALTER TABLE "stage_history" DROP COLUMN "note";        -- NON-ADDITIVE
ALTER TABLE "stage_history" DROP COLUMN "createdAt";   -- NON-ADDITIVE
ALTER TABLE "stage_history" DROP COLUMN "updatedAt";   -- NON-ADDITIVE
ALTER TABLE "stage_history" DROP COLUMN "fromStage";   -- NON-ADDITIVE (free string -> enum)
ALTER TABLE "stage_history" DROP COLUMN "toStage";     -- NON-ADDITIVE
ALTER TABLE "stage_history" ADD COLUMN "system_id" UUID NOT NULL;
ALTER TABLE "stage_history" ADD COLUMN "from_stage" "stage";
ALTER TABLE "stage_history" ADD COLUMN "to_stage" "stage" NOT NULL;
ALTER TABLE "stage_history" ADD COLUMN "via" "history_via" NOT NULL DEFAULT 'AUTO';

-- ============ PHASE 11 — projects.health value replacement ==================
-- NON-ADDITIVE: Health(ON_TRACK/AT_RISK/BLOCKED) -> health(OK/WATCH/FAULT/SERVICE).
DROP INDEX "projects_health_idx";
ALTER TABLE "projects" ALTER COLUMN "health" DROP DEFAULT;
ALTER TABLE "projects" ALTER COLUMN "health" TYPE "health"
  USING (CASE "health"::text WHEN 'ON_TRACK' THEN 'OK' WHEN 'AT_RISK' THEN 'WATCH' WHEN 'BLOCKED' THEN 'FAULT' ELSE 'OK' END)::"health"; -- NON-ADDITIVE
ALTER TABLE "projects" ALTER COLUMN "health" SET DEFAULT 'OK';
CREATE INDEX "projects_health_idx" ON "projects"("health");

-- ============ PHASE 12a — relax retained scalar columns =====================
ALTER TABLE "tasks" ALTER COLUMN "assigneeId" DROP NOT NULL;  -- NON-ADDITIVE (FK to platform_users dropped)
ALTER TABLE "contacts" DROP COLUMN "userId";                  -- NON-ADDITIVE

-- ============ PHASE 13 — create the lifecycle tables ========================
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,
    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "systems" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" TEXT NOT NULL,
    "unit_label" TEXT,
    "address_line" TEXT,
    "resident_id" UUID,
    "stage" "stage" NOT NULL DEFAULT 'S01_LEAD',
    "blocked_code" TEXT,
    "blocked_at" TIMESTAMP(3),
    "blocked_note" TEXT,
    "terminal_state" "terminal_state",
    "terminal_reason" TEXT,
    "terminal_at" TIMESTAMP(3),
    "health" "health",
    "flags" "flag"[] DEFAULT ARRAY[]::"flag"[],
    "source" TEXT,
    "connection_method" "connection",
    "tier" "tier",
    "locked_rates" JSONB,
    "current_snapshot_id" UUID,
    "kw_rated" DECIMAL(65,30),
    "kwh_rated" DECIMAL(65,30),
    "grid_edge" BOOLEAN,
    "rof_date" DATE,
    "rof_deadline" DATE,
    "install_date" DATE,
    "pis_date" DATE,
    "cof_date" DATE,
    "term_end" DATE,
    "warranty_end" DATE,
    "recapture_end" DATE,
    "cgb_app_no" TEXT,
    "edc_account_no" TEXT,
    "edc_account_name" TEXT,
    "ix_app_no" TEXT,
    "enlighten_site_id" TEXT,
    "gateway_sn" TEXT,
    "derms_id" TEXT,
    "permit_no" TEXT,
    "installer_of_record" JSONB,
    "grid_profile" TEXT,
    "fw_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "systems_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "account_type" NOT NULL,
    "name" TEXT NOT NULL,
    "deal_state" "deal_state",
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "residents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "name" TEXT,
    "edc_account_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "since" DATE,
    "until" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "residents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "qual_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "inputs" JSONB,
    "tier" "tier",
    "itc_profile" JSONB,
    "revenue_projection" JSONB,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qual_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "program" TEXT NOT NULL DEFAULT 'ct_ess',
    "app_no" TEXT,
    "submitted_at" TIMESTAMP(3),
    "rof_date" DATE,
    "rof_deadline" DATE,
    "cof_date" DATE,
    "tier" "tier",
    "rates" JSONB,
    "status" TEXT,
    "deficiency_due" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stage" "stage" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "conditional" TEXT,
    "auto_only" BOOLEAN NOT NULL DEFAULT false,
    "owner_role" "role",
    "sort" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checklist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "stage" "stage" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "state" "checklist_state" NOT NULL DEFAULT 'OPEN',
    "owner_role" "role",
    "doc_id" TEXT,
    "done_at" TIMESTAMP(3),
    "done_by" TEXT,
    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "installer_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "members" JSONB,
    "capacity_per_day" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "category" "ticket_category" NOT NULL,
    "source" TEXT,
    "severity" "alert_severity",
    "state" "ticket_state" NOT NULL DEFAULT 'NEW',
    "linked_alert_id" TEXT,
    "linked_event_id" UUID,
    "remote_log" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "work_order_id" TEXT,
    "warranty_flag" BOOLEAN NOT NULL DEFAULT false,
    "rma" JSONB,
    "resolution_code" "resolution_code",
    "resolved_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "seasons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "program_year" INTEGER NOT NULL,
    "window" JSONB,
    "status" "season_status" NOT NULL DEFAULT 'OPEN',
    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "season_id" UUID,
    "date" DATE NOT NULL,
    "window" TEXT,
    "kw_nominated" DECIMAL(65,30),
    "kw_delivered" DECIMAL(65,30),
    "ratio" DECIMAL(65,30),
    "soc_start" DECIMAL(65,30),
    "online" BOOLEAN,
    "source" "event_source",
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "turnover_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sla_due" TIMESTAMP(3),
    "tasks" JSONB,
    "closed_at" TIMESTAMP(3),
    CONSTRAINT "turnover_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "type" "ledger_type" NOT NULL,
    "season_id" UUID,
    "cohort_id" UUID,
    "expected_amt" DECIMAL(65,30),
    "expected_date" DATE,
    "received_amt" DECIMAL(65,30),
    "received_date" DATE,
    "status" "ledger_status" NOT NULL DEFAULT 'EXPECTED',
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "itc_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_id" UUID NOT NULL,
    "status" "claim_status" NOT NULL DEFAULT 'ACCRUING',
    "basis_amt" DECIMAL(65,30),
    "stack" JSONB,
    "total_pct" DECIMAL(65,30),
    "credit_amt" DECIMAL(65,30),
    "pis_date" DATE,
    "recapture_end" DATE,
    "evidence" JSONB,
    "cohort_id" UUID,
    CONSTRAINT "itc_claims_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "itc_basis_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claim_id" UUID NOT NULL,
    "source" "basis_source" NOT NULL,
    "amount" DECIMAL(65,30),
    "doc_id" TEXT,
    CONSTRAINT "itc_basis_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "itc_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_year" INTEGER NOT NULL,
    "category" "alloc_category" NOT NULL,
    "kw_applied" DECIMAL(65,30),
    "kw_awarded" DECIMAL(65,30),
    "award_doc_id" TEXT,
    "kw_consumed" DECIMAL(65,30),
    CONSTRAINT "itc_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "itc_cohorts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "status" "cohort_status" NOT NULL DEFAULT 'ASSEMBLING',
    "nominal_amt" DECIMAL(65,30),
    "price_cents" INTEGER,
    "buyer" TEXT,
    "executed_at" TIMESTAMP(3),
    "cash_at" TIMESTAMP(3),
    CONSTRAINT "itc_cohorts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blocked_codes" (
    "code" TEXT NOT NULL,
    "stage" "stage" NOT NULL,
    "label" TEXT NOT NULL,
    "today_after_days" INTEGER NOT NULL DEFAULT 3,
    CONSTRAINT "blocked_codes_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "clocks" (
    "key" TEXT NOT NULL,
    "starts_on" TEXT NOT NULL,
    "length_months" INTEGER,
    "length_days" INTEGER,
    "warn_at" TEXT,
    "consequence" TEXT,
    CONSTRAINT "clocks_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "rate_tables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_year" INTEGER NOT NULL,
    "tier" "tier" NOT NULL,
    "annual_rate_kw_yr" DECIMAL(65,30),
    "enroll_rate_grid_edge" DECIMAL(65,30),
    "enroll_rate_other" DECIMAL(65,30),
    "confirm" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "rate_tables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alert_rules" (
    "key" TEXT NOT NULL,
    "trigger_desc" TEXT NOT NULL,
    "severity" "alert_severity" NOT NULL,
    "auto_action" TEXT,
    "verify_desc" TEXT,
    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "po_no" TEXT NOT NULL,
    "vendor" TEXT,
    "ordered_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "status" "po_status" NOT NULL DEFAULT 'DRAFT',
    "lines" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- ============ PHASE 14 — DATA BACKFILL: spine + applications -> systems =====
-- Deterministic, pure-SQL. qual_snapshots (R4) are written by the JS backfill after.
CREATE TEMP TABLE "_sysmap" (
    system_id UUID NOT NULL DEFAULT gen_random_uuid(),
    src TEXT NOT NULL,
    project_id TEXT,
    lead_id TEXT,
    application_id INTEGER,
    property_id TEXT NOT NULL,
    stage "stage" NOT NULL,
    terminal_state "terminal_state",
    terminal_reason TEXT,
    at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- (a) each Project -> one system; stage per §6b + R3 (no ROF source -> S04).
INSERT INTO "_sysmap" (src, project_id, property_id, stage, at)
SELECT 'project', p."id", p."siteAddressId",
  (CASE p."stage"::text
     WHEN 'DESIGN' THEN 'S03_COMMITTED'
     WHEN 'SITE_SURVEY' THEN 'S03_COMMITTED'
     WHEN 'PERMITTING' THEN 'S04_APPLIED'
     WHEN 'INTERCONNECTION' THEN 'S04_APPLIED'
     WHEN 'SCHEDULED' THEN 'S06_SCHEDULED'
     WHEN 'INSTALLED' THEN 'S07_INSTALLED'
     WHEN 'INSPECTION' THEN 'S08_COMMISSIONED'
     WHEN 'PTO' THEN 'S08_COMMISSIONED'
     WHEN 'MONITORING' THEN 'S09_LIVE'
     WHEN 'ACTIVE' THEN 'OPERATING'
     ELSE 'S03_COMMITTED' END)::"stage",
  p."updatedAt"
FROM "projects" p;

-- (b) unconverted SalesLeads -> systems at S01/S02; DISQUALIFIED -> terminal (L2, stage preserved).
INSERT INTO "_sysmap" (src, lead_id, property_id, stage, terminal_state, terminal_reason, at)
SELECT 'lead', l."id", l."addressId",
  (CASE l."status"::text WHEN 'QUALIFIED' THEN 'S02_QUALIFIED' ELSE 'S01_LEAD' END)::"stage",
  (CASE WHEN l."status"::text = 'DISQUALIFIED' THEN 'DISQUALIFIED' ELSE NULL END)::"terminal_state",
  (CASE WHEN l."status"::text = 'DISQUALIFIED' THEN l."disqualifyReason" ELSE NULL END),
  l."updatedAt"
FROM "sales_leads" l
WHERE l."convertedCustomerId" IS NULL;

-- (c) Applications -> systems, deduped by address (§6f). Create a property per distinct address first.
CREATE TEMP TABLE "_appmap" (application_id INTEGER, property_id TEXT NOT NULL DEFAULT gen_random_uuid()::text);
INSERT INTO "_appmap" (application_id)
SELECT DISTINCT ON (a."formatted_address") a."id"
FROM "applications" a
ORDER BY a."formatted_address", a."id";

INSERT INTO "properties" ("id", "line1", "city", "state", "postal_code", "county", "lat", "lng", "created_at", "updated_at")
SELECT m."property_id", a."formatted_address", a."city", 'CT', '', 'Unknown', a."lat", a."lng", now(), now()
FROM "_appmap" m JOIN "applications" a ON a."id" = m."application_id";

INSERT INTO "_sysmap" (src, application_id, property_id, stage, at)
SELECT 'application', m."application_id", m."property_id",
  (CASE WHEN a."status"::text = 'SIGNED' AND a."agree_esign" THEN 'S03_COMMITTED' ELSE 'S01_LEAD' END)::"stage",
  a."updated_at"
FROM "_appmap" m JOIN "applications" a ON a."id" = m."application_id";

-- Insert systems.
INSERT INTO "systems" (
  "id", "property_id", "address_line", "stage", "terminal_state", "terminal_reason", "terminal_at",
  "health", "source", "kw_rated", "kwh_rated", "ix_app_no", "permit_no", "enlighten_site_id",
  "created_at", "updated_at")
SELECT
  m."system_id", m."property_id",
  (SELECT pr."line1" || ', ' || COALESCE(pr."city", '') || ', ' || pr."state" || ' ' || pr."postal_code"
     FROM "properties" pr WHERE pr."id" = m."property_id"),
  m."stage", m."terminal_state", m."terminal_reason",
  (CASE WHEN m."terminal_state" IS NOT NULL THEN now() ELSE NULL END),
  (CASE WHEN m."src" = 'project' AND m."stage"::text IN ('S09_LIVE', 'OPERATING')
        THEN (SELECT pj."health" FROM "projects" pj WHERE pj."id" = m."project_id") ELSE NULL END),
  COALESCE(
    (CASE WHEN m."src" = 'lead' THEN lower((SELECT sl."source"::text FROM "sales_leads" sl WHERE sl."id" = m."lead_id")) END),
    (CASE WHEN m."src" = 'application' THEN 'landing' END),
    'manual'),
  (SELECT sd."continuousKw" FROM "system_designs" sd WHERE sd."projectId" = m."project_id" AND sd."isCurrent" LIMIT 1),
  (SELECT sd."usableKwh" FROM "system_designs" sd WHERE sd."projectId" = m."project_id" AND sd."isCurrent" LIMIT 1),
  (SELECT ic."applicationNumber" FROM "interconnections" ic WHERE ic."projectId" = m."project_id"),
  (SELECT pm."number" FROM "permits" pm WHERE pm."projectId" = m."project_id" AND pm."number" IS NOT NULL ORDER BY pm."number" LIMIT 1),
  (SELECT ms."providerSiteId" FROM "monitoring_sites" ms WHERE ms."projectId" = m."project_id"),
  now(), now()
FROM "_sysmap" m;

-- Residents (one occupancy row per system) + point systems.resident_id at it.
INSERT INTO "residents" ("system_id", "name", "edc_account_name", "phone", "email", "since", "created_at")
SELECT m."system_id", c."firstName" || ' ' || c."lastName", c."firstName" || ' ' || c."lastName", c."phone", c."email", cu."createdAt"::date, now()
FROM "_sysmap" m
JOIN "projects" p ON p."id" = m."project_id"
JOIN "customers" cu ON cu."id" = p."customerId"
JOIN "contacts" c ON c."id" = cu."contactId"
WHERE m."src" = 'project';

INSERT INTO "residents" ("system_id", "name", "edc_account_name", "phone", "email", "since", "created_at")
SELECT m."system_id", c."firstName" || ' ' || c."lastName", c."firstName" || ' ' || c."lastName", c."phone", c."email", l."createdAt"::date, now()
FROM "_sysmap" m
JOIN "sales_leads" l ON l."id" = m."lead_id"
JOIN "contacts" c ON c."id" = l."contactId"
WHERE m."src" = 'lead';

INSERT INTO "residents" ("system_id", "name", "edc_account_name", "phone", "email", "since", "created_at")
SELECT m."system_id", a."first_name" || ' ' || a."last_name", a."first_name" || ' ' || a."last_name", a."phone", a."email", a."created_at"::date, now()
FROM "_sysmap" m
JOIN "applications" a ON a."id" = m."application_id"
WHERE m."src" = 'application';

UPDATE "systems" s SET "resident_id" = r."id"
FROM "residents" r WHERE r."system_id" = s."id";

-- Synthetic stage_history: one AUTO 'backfill' row per system so v_stage_age is sane from day one.
INSERT INTO "stage_history" ("id", "system_id", "from_stage", "to_stage", "at", "by", "via")
SELECT gen_random_uuid()::text, m."system_id", NULL, m."stage", m."at", 'backfill', 'AUTO'
FROM "_sysmap" m;

-- Relink reshaped child rows to their system via the retained project link.
UPDATE "equipment" e SET "system_id" = m."system_id"
FROM "_sysmap" m WHERE m."src" = 'project' AND e."projectId" = m."project_id";

UPDATE "documents" d
SET "system_id" = m."system_id",
    "property_id" = (SELECT p."siteAddressId" FROM "projects" p WHERE p."id" = m."project_id")
FROM "_sysmap" m WHERE m."src" = 'project' AND d."projectId" = m."project_id";

-- Legacy alerts carry only free-form codes; rule_key stays NULL (legacy code lives in context).
UPDATE "alerts" al SET "system_id" = m."system_id"
FROM "_sysmap" m WHERE m."src" = 'project' AND al."projectId" = m."project_id";

UPDATE "work_orders" w SET "system_id" = m."system_id"
FROM "_sysmap" m WHERE m."src" = 'project' AND w."projectId" = m."project_id";

DROP TABLE "_sysmap";
DROP TABLE "_appmap";

-- ============ PHASE 15 — finalize reshaped tables (drop legacy link cols) ===
DELETE FROM "alerts" WHERE "system_id" IS NULL; -- NON-ADDITIVE (orphan demo alerts with no mapped system)
ALTER TABLE "alerts" ALTER COLUMN "system_id" SET NOT NULL;
ALTER TABLE "alerts" DROP COLUMN "monitoringSiteId"; -- NON-ADDITIVE
ALTER TABLE "alerts" DROP COLUMN "projectId";        -- NON-ADDITIVE
ALTER TABLE "alerts" DROP COLUMN "code";             -- NON-ADDITIVE (folded into context)
ALTER TABLE "alerts" DROP COLUMN "message";          -- NON-ADDITIVE (folded into context)
ALTER TABLE "alerts" DROP COLUMN "acknowledgedAt";   -- NON-ADDITIVE
ALTER TABLE "alerts" DROP COLUMN "workOrderId";      -- NON-ADDITIVE

ALTER TABLE "equipment" DROP COLUMN "projectId";      -- NON-ADDITIVE
ALTER TABLE "equipment" DROP COLUMN "batteryModelId"; -- NON-ADDITIVE
ALTER TABLE "equipment" DROP COLUMN "warrantyEndsAt"; -- NON-ADDITIVE (warranty_end lives on systems)

ALTER TABLE "documents" DROP COLUMN "customerId"; -- NON-ADDITIVE
ALTER TABLE "documents" DROP COLUMN "projectId";  -- NON-ADDITIVE

ALTER TABLE "work_orders" DROP COLUMN "projectId";    -- NON-ADDITIVE
ALTER TABLE "work_orders" DROP COLUMN "contractorId"; -- NON-ADDITIVE

-- ============ PHASE 16 — drop obsolete tables + enums =======================
DROP TABLE "contractor_users"; -- NON-ADDITIVE (superseded by crews)
DROP TABLE "platform_users";   -- NON-ADDITIVE (consolidated into users)
DROP TYPE "user_role";       -- NON-ADDITIVE
DROP TYPE "PlatformRole";    -- NON-ADDITIVE
DROP TYPE "ContractorRole";  -- NON-ADDITIVE
DROP TYPE "ContractorStatus";-- NON-ADDITIVE
DROP TYPE "SubjectType";     -- NON-ADDITIVE
DROP TYPE "Health";          -- NON-ADDITIVE
DROP TYPE "Severity";        -- NON-ADDITIVE
DROP TYPE "DocType";         -- NON-ADDITIVE
DROP TYPE "DocStatus";       -- NON-ADDITIVE
DROP TYPE "AssetStatus";     -- NON-ADDITIVE
DROP TYPE "WorkOrderStatus"; -- NON-ADDITIVE

-- ============ PHASE 17 — indexes + unique constraints =======================
CREATE INDEX "activity_log_entity_entity_id_idx" ON "activity_log"("entity", "entity_id");
CREATE INDEX "systems_stage_idx" ON "systems"("stage");
CREATE INDEX "systems_property_id_idx" ON "systems"("property_id");
CREATE INDEX "systems_health_idx" ON "systems"("health");
CREATE INDEX "systems_blocked_code_idx" ON "systems"("blocked_code");
CREATE UNIQUE INDEX "systems_property_id_unit_label_key" ON "systems"("property_id", "unit_label");
CREATE INDEX "account_contacts_account_id_idx" ON "account_contacts"("account_id");
CREATE INDEX "residents_system_id_idx" ON "residents"("system_id");
CREATE INDEX "qual_snapshots_system_id_idx" ON "qual_snapshots"("system_id");
CREATE INDEX "enrollments_system_id_idx" ON "enrollments"("system_id");
CREATE UNIQUE INDEX "checklist_templates_stage_key_key" ON "checklist_templates"("stage", "key");
CREATE INDEX "checklist_items_system_id_idx" ON "checklist_items"("system_id");
CREATE UNIQUE INDEX "checklist_items_system_id_stage_key_key" ON "checklist_items"("system_id", "stage", "key");
CREATE INDEX "stage_history_system_id_idx" ON "stage_history"("system_id");
CREATE UNIQUE INDEX "stage_history_system_id_from_stage_to_stage_key" ON "stage_history"("system_id", "from_stage", "to_stage");
CREATE INDEX "crews_installer_id_idx" ON "crews"("installer_id");
CREATE INDEX "equipment_system_id_idx" ON "equipment"("system_id");
CREATE INDEX "tickets_system_id_idx" ON "tickets"("system_id");
CREATE INDEX "events_system_id_idx" ON "events"("system_id");
CREATE UNIQUE INDEX "events_system_id_date_window_key" ON "events"("system_id", "date", "window");
CREATE INDEX "turnover_cases_system_id_idx" ON "turnover_cases"("system_id");
CREATE INDEX "ledger_entries_system_id_idx" ON "ledger_entries"("system_id");
CREATE UNIQUE INDEX "itc_claims_system_id_key" ON "itc_claims"("system_id");
CREATE INDEX "itc_basis_lines_claim_id_idx" ON "itc_basis_lines"("claim_id");
CREATE UNIQUE INDEX "rate_tables_program_year_tier_key" ON "rate_tables"("program_year", "tier");
CREATE UNIQUE INDEX "purchase_orders_po_no_key" ON "purchase_orders"("po_no");
CREATE INDEX "alerts_system_id_idx" ON "alerts"("system_id");
CREATE INDEX "alerts_rule_key_idx" ON "alerts"("rule_key");
CREATE INDEX "bids_jobPostingId_idx" ON "bids"("jobPostingId");
CREATE INDEX "documents_system_id_idx" ON "documents"("system_id");
CREATE INDEX "documents_property_id_idx" ON "documents"("property_id");
CREATE UNIQUE INDEX "work_orders_job_posting_id_key" ON "work_orders"("job_posting_id");
CREATE INDEX "work_orders_system_id_idx" ON "work_orders"("system_id");

-- ============ PHASE 18 — foreign keys =======================================
ALTER TABLE "systems" ADD CONSTRAINT "systems_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "systems" ADD CONSTRAINT "systems_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "systems" ADD CONSTRAINT "systems_blocked_code_fkey" FOREIGN KEY ("blocked_code") REFERENCES "blocked_codes"("code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "account_contacts" ADD CONSTRAINT "account_contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_master_agmt_doc_id_fkey" FOREIGN KEY ("master_agmt_doc_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_ahj_id_fkey" FOREIGN KEY ("ahj_id") REFERENCES "ahjs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "residents" ADD CONSTRAINT "residents_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qual_snapshots" ADD CONSTRAINT "qual_snapshots_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crews" ADD CONSTRAINT "crews_installer_id_fkey" FOREIGN KEY ("installer_id") REFERENCES "installers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_job_posting_id_fkey" FOREIGN KEY ("job_posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_attestation_doc_id_fkey" FOREIGN KEY ("attestation_doc_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_key_fkey" FOREIGN KEY ("rule_key") REFERENCES "alert_rules"("key") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_linked_event_id_fkey" FOREIGN KEY ("linked_event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "turnover_cases" ADD CONSTRAINT "turnover_cases_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "itc_cohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "itc_claims" ADD CONSTRAINT "itc_claims_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "itc_claims" ADD CONSTRAINT "itc_claims_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "itc_cohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "itc_basis_lines" ADD CONSTRAINT "itc_basis_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "itc_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============ PHASE 19 — derived view v_stage_age (01 §Derived) =============
CREATE VIEW "v_stage_age" AS
SELECT s."id" AS system_id,
       s."stage",
       h."at" AS entered_stage_at,
       (now() - h."at") AS age_interval,
       EXTRACT(EPOCH FROM (now() - h."at")) / 86400.0 AS days_in_stage
FROM "systems" s
LEFT JOIN LATERAL (
  SELECT sh."at"
  FROM "stage_history" sh
  WHERE sh."system_id" = s."id" AND sh."to_stage" = s."stage"
  ORDER BY sh."at" DESC
  LIMIT 1
) h ON true;
