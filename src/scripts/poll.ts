/**
 * Monitoring poll pass — the cron worker (02 §Automations).
 *
 * Reads the telemetry store for every watched system, drives the telemetry
 * alert rules, confirms S07 telemetry, blocks stale DERMS, refreshes the health
 * cache, and verifies any claimed resolution whose machine check now passes.
 *
 * Suggested crontab (droplet, four times an hour):
 *   0,15,30,45 * * * * cd /srv/ctbs-backend && node dist/scripts/poll.js >> /var/log/ctbs-poll.log 2>&1
 *
 *   npm run poll
 */
import prisma from '../config/database';
import { pollFleet } from '../services/poller.service';

pollFleet()
  .then((r) => {
    const acted = r.outcomes.filter((o) => o.actions.length);
    console.log(`[poll] ${r.at.toISOString()} — ${r.polled} polled, ${r.skippedNoSite} without a site link, ${r.verified} verified`);
    for (const o of acted) console.log(`  ${o.address ?? o.systemId} (${o.stage}): ${o.actions.join(' · ')}`);
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('[poll] failed', e);
    await prisma.$disconnect();
    process.exit(1);
  });
