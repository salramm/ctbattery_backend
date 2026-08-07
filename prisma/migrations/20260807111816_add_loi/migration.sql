-- CreateTable
CREATE TABLE "lois" (
    "id" SERIAL NOT NULL,
    "loi_number" VARCHAR(32) NOT NULL,
    "site_owner_name" VARCHAR(200) NOT NULL,
    "property_address" VARCHAR(400) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(40),
    "battery_count" VARCHAR(20),
    "rooftop_solar" VARCHAR(20),
    "timeframe" VARCHAR(20),
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason_other" VARCHAR(300),
    "signed_name" VARCHAR(200) NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_ip" VARCHAR(64),
    "source" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lois_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lois_loi_number_key" ON "lois"("loi_number");

-- CreateIndex
CREATE INDEX "lois_email_idx" ON "lois"("email");

-- CreateIndex
CREATE INDEX "lois_created_at_idx" ON "lois"("created_at");
