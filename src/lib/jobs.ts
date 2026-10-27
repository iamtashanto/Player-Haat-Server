import { expireStaleRequests } from "../modules/maintenance/expire-stale-requests.js";
import { purgeExpiredData } from "../modules/maintenance/purge-expired-data.js";
import { sweepOrphanUploads } from "../modules/maintenance/sweep-orphan-uploads.js";
import { sendFollowupRatingReminders } from "../modules/ratings/rating-reminders.js";
import { logger } from "./logger.js";

interface Job {
  name: string;
  everyMs: number;
  /** Delay before the first run, so jobs don't all fire at boot (and instances don't stampede). */
  firstRunMs: number;
  run: () => Promise<unknown>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const jobs: Job[] = [
  { name: "rating-reminders", everyMs: 15 * MINUTE, firstRunMs: MINUTE, run: () => sendFollowupRatingReminders() },
  { name: "expire-stale-requests", everyMs: HOUR, firstRunMs: 5 * MINUTE, run: () => expireStaleRequests() },
  { name: "purge-expired-data", everyMs: 24 * HOUR, firstRunMs: 10 * MINUTE, run: () => purgeExpiredData() },
  { name: "sweep-orphan-uploads", everyMs: 24 * HOUR, firstRunMs: 30 * MINUTE, run: () => sweepOrphanUploads() },
];

/**
 * In-process scheduler. Each job runs on an interval, never overlaps itself, and logs (never throws).
 * Jobs must be safe to run on several instances at once: the reminder job takes a Postgres advisory
 * lock (it sends notifications); the rest are idempotent, so a duplicate run just finds nothing to do. Returns a function that stops everything.
 */
export function startJobs(): () => void {
  const timers = jobs.map((job) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await job.run();
        if (result) logger.info({ job: job.name, result }, "job finished");
      } catch (err) {
        logger.error({ err, job: job.name }, "job failed");
      } finally {
        running = false;
      }
    };
    const first = setTimeout(tick, job.firstRunMs);
    const every = setInterval(tick, job.everyMs);
    first.unref();
    every.unref();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  });
  logger.info({ jobs: jobs.map((j) => j.name) }, "background jobs started");
  return () => timers.forEach((stop) => stop());
}
