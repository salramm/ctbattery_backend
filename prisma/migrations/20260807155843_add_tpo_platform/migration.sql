-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEB', 'REFERRAL', 'PARTNER', 'CANVASS', 'UTILITY_LIST');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('LOI_SENT', 'LOI_SIGNED', 'CREDIT_APPROVED', 'AGREEMENT_SIGNED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('LOI', 'TPO_AGREEMENT', 'NTP', 'PERMIT_SET', 'PHOTO', 'INSPECTION_REPORT', 'COI');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'VOID');

-- CreateEnum
CREATE TYPE "ProjectStage" AS ENUM ('DESIGN', 'SITE_SURVEY', 'PERMITTING', 'INTERCONNECTION', 'SCHEDULED', 'INSTALLED', 'INSPECTION', 'PTO', 'MONITORING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "Health" AS ENUM ('ON_TRACK', 'AT_RISK', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'ALLOCATED', 'INSTALLED', 'RMA', 'RETIRED');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('SCHEDULED', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "PermitType" AS ENUM ('ELECTRICAL', 'BUILDING', 'FIRE');

-- CreateEnum
CREATE TYPE "PermitStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'CORRECTIONS', 'APPROVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IxStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'IN_REVIEW', 'APPROVED_TO_INSTALL', 'PTO_GRANTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "ContractorStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ContractorRole" AS ENUM ('ADMIN', 'TECH');

-- CreateEnum
CREATE TYPE "JobScope" AS ENUM ('SITE_SURVEY', 'INSTALL', 'SERVICE', 'REMOVAL');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('OPEN', 'AWARDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('AWARDED', 'SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'REWORK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('LEAD', 'CUSTOMER', 'PROJECT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SALES_REP', 'SALES_MANAGER', 'OPS', 'ADMIN', 'CONTRACTOR', 'HOMEOWNER');

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_transitions" (
    "id" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "leadId" TEXT,
    "assigneeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "projectId" TEXT,
    "type" "DocType" NOT NULL,
    "status" "DocStatus" NOT NULL DEFAULT 'DRAFT',
    "esignEnvelopeId" TEXT,
    "signedAt" TIMESTAMP(3),
    "fileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utilities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "territoryCode" TEXT NOT NULL,
    "interconnectionPortalUrl" TEXT,
    "standardReviewDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "utilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ahjs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "permitPortalUrl" TEXT,
    "avgApprovalDays" INTEGER,
    "requiresStructural" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ahjs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CT',
    "postalCode" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "utilityId" TEXT,
    "ahjId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_leads" (
    "id" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ownerId" TEXT,
    "source" "LeadSource" NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "disqualifyReason" TEXT,
    "estimatedMonthlyBill" DECIMAL(65,30),
    "convertedCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "serviceAddressId" TEXT NOT NULL,
    "billingAddressId" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'LOI_SENT',
    "creditTier" TEXT,
    "creditCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "siteAddressId" TEXT NOT NULL,
    "stage" "ProjectStage" NOT NULL DEFAULT 'DESIGN',
    "health" "Health" NOT NULL DEFAULT 'ON_TRACK',
    "projectManagerId" TEXT,
    "termYears" INTEGER NOT NULL DEFAULT 20,
    "monthlyRateCents" INTEGER NOT NULL,
    "targetPtoDate" TIMESTAMP(3),
    "actualPtoDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battery_models" (
    "id" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "nameplateKwh" DECIMAL(65,30) NOT NULL,
    "continuousKw" DECIMAL(65,30) NOT NULL,
    "chemistry" TEXT NOT NULL,
    "warrantyYears" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "battery_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_designs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "batteryModelId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "usableKwh" DECIMAL(65,30) NOT NULL,
    "continuousKw" DECIMAL(65,30) NOT NULL,
    "inverterModel" TEXT NOT NULL,
    "solarCoupled" BOOLEAN NOT NULL DEFAULT false,
    "backupLoads" JSONB,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battery_assets" (
    "id" TEXT NOT NULL,
    "batteryModelId" TEXT NOT NULL,
    "projectId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "installedAt" TIMESTAMP(3),
    "warrantyEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "battery_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_surveys" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "SurveyStatus" NOT NULL DEFAULT 'SCHEDULED',
    "mainPanelAmps" INTEGER,
    "findings" JSONB,
    "photoDocIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permits" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ahjId" TEXT NOT NULL,
    "type" "PermitType" NOT NULL,
    "number" TEXT,
    "status" "PermitStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interconnections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "utilityId" TEXT NOT NULL,
    "applicationNumber" TEXT,
    "status" "IxStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "ptoAt" TIMESTAMP(3),
    "programEnrollment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interconnections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "permitId" TEXT,
    "type" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "result" "InspectionResult" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractors" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "licenseExpiresAt" TIMESTAMP(3) NOT NULL,
    "insuranceExpiresAt" TIMESTAMP(3) NOT NULL,
    "serviceCounties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rating" DOUBLE PRECISION,
    "status" "ContractorStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_users" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ContractorRole" NOT NULL DEFAULT 'TECH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scope" "JobScope" NOT NULL,
    "county" TEXT NOT NULL,
    "budgetCents" INTEGER,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "bidsCloseAt" TIMESTAMP(3) NOT NULL,
    "status" "PostingStatus" NOT NULL DEFAULT 'OPEN',
    "awardedBidId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bids" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "proposedStart" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "BidStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "scope" "JobScope" NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'AWARDED',
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "checklist" JSONB,
    "qualityScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_sites" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSiteId" TEXT NOT NULL,
    "commissionedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "monitoringSiteId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "soc" DOUBLE PRECISION NOT NULL,
    "powerKw" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL,
    "gridConnected" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "telemetry_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "monitoringSiteId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "workOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "stage_transitions_subjectType_subjectId_idx" ON "stage_transitions"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "tasks_projectId_idx" ON "tasks"("projectId");

-- CreateIndex
CREATE INDEX "documents_projectId_idx" ON "documents"("projectId");

-- CreateIndex
CREATE INDEX "addresses_county_idx" ON "addresses"("county");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_email_key" ON "contacts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_userId_key" ON "contacts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_leads_convertedCustomerId_key" ON "sales_leads"("convertedCustomerId");

-- CreateIndex
CREATE INDEX "sales_leads_status_idx" ON "sales_leads"("status");

-- CreateIndex
CREATE UNIQUE INDEX "customers_leadId_key" ON "customers"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_customerId_key" ON "projects"("customerId");

-- CreateIndex
CREATE INDEX "projects_stage_idx" ON "projects"("stage");

-- CreateIndex
CREATE INDEX "projects_health_idx" ON "projects"("health");

-- CreateIndex
CREATE INDEX "system_designs_projectId_idx" ON "system_designs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "battery_assets_serialNumber_key" ON "battery_assets"("serialNumber");

-- CreateIndex
CREATE INDEX "battery_assets_status_idx" ON "battery_assets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "site_surveys_projectId_key" ON "site_surveys"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "site_surveys_workOrderId_key" ON "site_surveys"("workOrderId");

-- CreateIndex
CREATE INDEX "permits_projectId_idx" ON "permits"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "interconnections_projectId_key" ON "interconnections"("projectId");

-- CreateIndex
CREATE INDEX "inspections_projectId_idx" ON "inspections"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_users_contractorId_userId_key" ON "contractor_users"("contractorId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_awardedBidId_key" ON "job_postings"("awardedBidId");

-- CreateIndex
CREATE INDEX "job_postings_status_idx" ON "job_postings"("status");

-- CreateIndex
CREATE INDEX "job_postings_county_idx" ON "job_postings"("county");

-- CreateIndex
CREATE UNIQUE INDEX "bids_jobPostingId_contractorId_key" ON "bids"("jobPostingId", "contractorId");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_jobPostingId_key" ON "work_orders"("jobPostingId");

-- CreateIndex
CREATE INDEX "work_orders_projectId_idx" ON "work_orders"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_sites_projectId_key" ON "monitoring_sites"("projectId");

-- CreateIndex
CREATE INDEX "telemetry_snapshots_monitoringSiteId_ts_idx" ON "telemetry_snapshots"("monitoringSiteId", "ts");

-- CreateIndex
CREATE INDEX "alerts_severity_idx" ON "alerts"("severity");

-- CreateIndex
CREATE INDEX "alerts_projectId_idx" ON "alerts"("projectId");

-- AddForeignKey
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "sales_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_utilityId_fkey" FOREIGN KEY ("utilityId") REFERENCES "utilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_ahjId_fkey" FOREIGN KEY ("ahjId") REFERENCES "ahjs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_serviceAddressId_fkey" FOREIGN KEY ("serviceAddressId") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_billingAddressId_fkey" FOREIGN KEY ("billingAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_siteAddressId_fkey" FOREIGN KEY ("siteAddressId") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_projectManagerId_fkey" FOREIGN KEY ("projectManagerId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_designs" ADD CONSTRAINT "system_designs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_designs" ADD CONSTRAINT "system_designs_batteryModelId_fkey" FOREIGN KEY ("batteryModelId") REFERENCES "battery_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battery_assets" ADD CONSTRAINT "battery_assets_batteryModelId_fkey" FOREIGN KEY ("batteryModelId") REFERENCES "battery_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battery_assets" ADD CONSTRAINT "battery_assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_surveys" ADD CONSTRAINT "site_surveys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_surveys" ADD CONSTRAINT "site_surveys_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permits" ADD CONSTRAINT "permits_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permits" ADD CONSTRAINT "permits_ahjId_fkey" FOREIGN KEY ("ahjId") REFERENCES "ahjs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconnections" ADD CONSTRAINT "interconnections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interconnections" ADD CONSTRAINT "interconnections_utilityId_fkey" FOREIGN KEY ("utilityId") REFERENCES "utilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_permitId_fkey" FOREIGN KEY ("permitId") REFERENCES "permits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_users" ADD CONSTRAINT "contractor_users_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_users" ADD CONSTRAINT "contractor_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_awardedBidId_fkey" FOREIGN KEY ("awardedBidId") REFERENCES "bids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "job_postings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "job_postings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_sites" ADD CONSTRAINT "monitoring_sites_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_snapshots" ADD CONSTRAINT "telemetry_snapshots_monitoringSiteId_fkey" FOREIGN KEY ("monitoringSiteId") REFERENCES "monitoring_sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_monitoringSiteId_fkey" FOREIGN KEY ("monitoringSiteId") REFERENCES "monitoring_sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
