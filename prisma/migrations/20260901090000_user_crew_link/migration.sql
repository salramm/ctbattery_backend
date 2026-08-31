-- Additive: link a user account to a crew.
--
-- 03 §Field mobile scopes the FIELD role to "only assigned work orders". That
-- needs a route from the signed-in account to a crew; without it the field
-- surface either shows one crew's work to everybody or shows nothing at all.
-- Nullable: ADMIN/OPS accounts have no crew and see the whole board.
ALTER TABLE "users" ADD COLUMN "crew_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_crew_id_fkey"
  FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "users_crew_id_idx" ON "users"("crew_id");
