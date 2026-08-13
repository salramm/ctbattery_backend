-- CreateTable
CREATE TABLE "mfah_properties" (
    "id" SERIAL NOT NULL,
    "project_name" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "zip" TEXT,
    "units" INTEGER,
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_operator" TEXT,
    "contact_email" TEXT,
    "multi_program_overlap" BOOLEAN NOT NULL DEFAULT false,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "census_tract_fips" TEXT,
    "norm_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfah_properties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mfah_properties_norm_address_idx" ON "mfah_properties"("norm_address");

-- CreateIndex
CREATE INDEX "mfah_properties_city_idx" ON "mfah_properties"("city");
