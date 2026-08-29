/**
 * DEPRECATED (P1 re-model, R2).
 *
 * This seeded the legacy "TPO operations platform" demo (address→contact→
 * SalesLead→Customer→Project→BatteryAsset + PlatformUser/Contractor/…). The
 * lifecycle re-model froze that spine and dropped several of the tables this
 * script wrote to (`battery_assets`→`equipment`, `contractors`→`installers`,
 * `platform_users`/`contractor_users` removed, `stage_transitions`→
 * `stage_history`, `addresses`→`properties`). Re-seeding the old shape would
 * write to the frozen spine, which the re-model forbids.
 *
 * The replacement is the lifecycle demo seed (one account → one property → 25
 * units across stages/health) delivered in P10. Until then, seed the lifecycle
 * reference/inventory tables with `src/scripts/seed-lifecycle.ts`.
 */
async function main(): Promise<void> {
  console.log(
    '[seed-tpo] Deprecated by the lifecycle re-model (P1). ' +
      'Run `ts-node src/scripts/seed-lifecycle.ts` for reference/inventory seeds; ' +
      'the 25-unit lifecycle demo seed lands in P10.',
  );
}

main();
