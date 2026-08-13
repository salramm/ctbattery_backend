-- AlterTable
ALTER TABLE "lois" ADD COLUMN     "energy_community" BOOLEAN,
ADD COLUMN     "ess_tier" VARCHAR(20),
ADD COLUMN     "itc_confirmed_pct" INTEGER,
ADD COLUMN     "itc_potential_pct" INTEGER,
ADD COLUMN     "lucrative_score" INTEGER,
ADD COLUMN     "nmtc_low_income" BOOLEAN,
ADD COLUMN     "underserved" BOOLEAN;

-- CreateIndex
CREATE INDEX "lois_lucrative_score_idx" ON "lois"("lucrative_score");
