/**
 * Clock sweep — the cron half of the clock engine (01 §Seed — clocks).
 *
 * Evaluates every clock across the fleet and logs each newly crossed threshold
 * once. Safe to run as often as you like: crossings are guarded in
 * `activity_log`, so a repeat pass writes nothing and notifies nobody.
 *
 * Suggested crontab (droplet, hourly on the hour):
 *   0 * * * * cd /srv/ctbs-backend && node dist/scripts/clock-sweep.js >> /var/log/ctbs-clocks.log 2>&1
 *
 *   npm run clocks:sweep
 */
import prisma from '../config/database';
import { sweepClocks } from '../lib/lifecycle';

sweepClocks()
  .then((r) => {
    console.log(`[clocks] ${r.at.toISOString()} — ${r.evaluated} in warn/due window, ${r.logged} newly crossed`);
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('[clocks] sweep failed', e);
    await prisma.$disconnect();
    process.exit(1);
  });
