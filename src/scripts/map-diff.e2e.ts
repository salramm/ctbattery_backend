/**
 * Lifecycle-map diff (P11 acceptance).
 *
 * The overlay is only worth having if it is a live projection of the seeds, so
 * this diffs what `GET /api/lifecycle/map` serves against a direct query of
 * `checklist_templates`, `blocked_codes` and `clocks`. Any difference in either
 * direction — an item the overlay invents, or a seed row it drops — is printed
 * and fails the run. The diff must be empty.
 *
 *   npm run test:map
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import { buildLifecycleMap, STAGE_ORDER, TRANSITIONS } from '../lib/lifecycle';

interface Diff {
  where: string;
  only_in_overlay: string[];
  only_in_seed: string[];
}

async function run() {
  const map = await buildLifecycleMap();
  const diffs: Diff[] = [];

  const compare = (where: string, overlay: string[], seed: string[]) => {
    const o = new Set(overlay);
    const s = new Set(seed);
    const onlyOverlay = [...o].filter((x) => !s.has(x)).sort();
    const onlySeed = [...s].filter((x) => !o.has(x)).sort();
    if (onlyOverlay.length || onlySeed.length) {
      diffs.push({ where, only_in_overlay: onlyOverlay, only_in_seed: onlySeed });
    }
  };

  // ---- gate items, per stage ------------------------------------------------
  for (const stage of STAGE_ORDER) {
    const entry = map.stages.find((s) => s.stage === stage);
    assert.ok(entry, `overlay covers ${stage}`);

    const templates = await prisma.checklistTemplate.findMany({ where: { stage }, orderBy: { sort: 'asc' } });
    // Compare the full row, not just the key: a wrong label or a dropped AUTO
    // badge is exactly the kind of drift this diff exists to catch.
    compare(
      `${stage} gate`,
      entry.gate.map((g) => `${g.key}|${g.label}|req=${g.required}|auto=${g.auto_only}|cond=${g.conditional ?? ''}|owner=${g.owner_role ?? ''}`),
      templates.map((t) => `${t.key}|${t.label}|req=${t.required}|auto=${t.autoOnly}|cond=${t.conditional ?? ''}|owner=${t.ownerRole ?? ''}`),
    );

    // order matters — the overlay lists gate items in the seed's sort order
    assert.deepEqual(
      entry.gate.map((g) => g.key),
      templates.map((t) => t.key),
      `${stage} gate items are in the seed's sort order`,
    );

    const codes = await prisma.blockedCode.findMany({ where: { stage } });
    compare(
      `${stage} block codes`,
      entry.block_codes.map((b) => `${b.code}|${b.label}|today=${b.today_after_days}`),
      codes.map((c) => `${c.code}|${c.label}|today=${c.todayAfterDays}`),
    );
  }

  // ---- clocks --------------------------------------------------------------
  const seedClocks = await prisma.clock.findMany();
  compare(
    'clocks',
    map.clocks.map((c) => `${c.key}|${c.starts_on}|mo=${c.length_months ?? ''}|d=${c.length_days ?? ''}|warn=${c.warn_at ?? ''}`),
    seedClocks.map((c) => `${c.key}|${c.startsOn}|mo=${c.lengthMonths ?? ''}|d=${c.lengthDays ?? ''}|warn=${c.warnAt ?? ''}`),
  );

  // Per-stage clock chips must be a subset of the seed, never invented.
  const seedKeys = new Set(seedClocks.map((c) => c.key));
  for (const stage of map.stages) {
    for (const c of stage.clocks) {
      assert.ok(seedKeys.has(c.key), `${stage.stage} clock chip ${c.key} exists in the seed`);
      const seed = seedClocks.find((s) => s.key === c.key)!;
      assert.equal(c.length_months, seed.lengthMonths, `${c.key} length_months matches the seed`);
      assert.equal(c.length_days, seed.lengthDays, `${c.key} length_days matches the seed`);
      assert.equal(c.warn_at, seed.warnAt, `${c.key} warn_at matches the seed`);
    }
  }

  // ---- transitions ---------------------------------------------------------
  assert.deepEqual(map.transitions, TRANSITIONS, 'transitions round-trip the locked constant');
  compare(
    'stage transitions',
    map.stages.filter((s) => s.transition).map((s) => `${s.stage}→${s.transition!.to}|${s.transition!.driver}`),
    TRANSITIONS.map((t) => `${t.from}→${t.to}|${t.driver}`),
  );

  // ---- report --------------------------------------------------------------
  if (diffs.length) {
    console.error('\n❌ overlay/seed diff is NOT empty:\n');
    for (const d of diffs) {
      console.error(`  ${d.where}`);
      for (const x of d.only_in_overlay) console.error(`    + overlay only: ${x}`);
      for (const x of d.only_in_seed) console.error(`    - seed only:    ${x}`);
    }
    process.exitCode = 1;
    return;
  }

  const totals = {
    stages: map.stages.length,
    gate_items: map.stages.reduce((n, s) => n + s.gate.length, 0),
    block_codes: map.stages.reduce((n, s) => n + s.block_codes.length, 0),
    clocks: map.clocks.length,
    transitions: map.transitions.length,
  };
  const seedTotals = {
    gate_items: await prisma.checklistTemplate.count(),
    block_codes: await prisma.blockedCode.count(),
    clocks: await prisma.clock.count(),
  };
  assert.equal(totals.gate_items, seedTotals.gate_items, 'every checklist_templates row is on the overlay');
  assert.equal(totals.block_codes, seedTotals.block_codes, 'every blocked_codes row is on the overlay');
  assert.equal(totals.clocks, seedTotals.clocks, 'every clocks row is on the overlay');

  console.log(
    `\n  overlay = ${totals.stages} stages · ${totals.gate_items} gate items · ${totals.block_codes} block codes · ` +
      `${totals.clocks} clocks · ${totals.transitions} transitions`,
  );
  console.log('\n✅ lifecycle-map diff EMPTY — the overlay is a projection of the seed tables.');
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ map diff FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
