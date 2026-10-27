import { prisma } from "../../lib/prisma.js";

const HOUR = 3_600_000;

/**
 * An OPEN request whose match time passed a day ago with nobody accepted is dead weight: it's already
 * hidden from the feed, but it would sit in the poster's "My requests" as OPEN forever. Cancel it and
 * close out any applications still pending.
 *
 * Deliberately NOT touched: requests with an accepted player (the poster must complete them so the
 * rating window can open) and FILLED/COMPLETED/CANCELLED ones. Idempotent, so running on several
 * instances at once is harmless.
 */
export async function expireStaleRequests(now = new Date(), opts: { graceHours?: number; batchSize?: number } = {}): Promise<number> {
  const cutoff = new Date(now.getTime() - (opts.graceHours ?? 24) * HOUR);
  const batchSize = opts.batchSize ?? 500;
  let total = 0;

  for (;;) {
    const stale = await prisma.playerRequest.findMany({
      where: { status: "OPEN", playersAccepted: 0, matchAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (stale.length === 0) return total;
    const ids = stale.map((r) => r.id);

    const cancelled = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction: the row may have changed since we looked.
      const { count } = await tx.playerRequest.updateMany({ where: { id: { in: ids }, status: "OPEN", playersAccepted: 0 }, data: { status: "CANCELLED" } });
      await tx.application.updateMany({ where: { requestId: { in: ids }, status: "PENDING" }, data: { status: "REJECTED", respondedAt: now } });
      return count;
    });
    total += cancelled;
    if (stale.length < batchSize || cancelled === 0) return total;
  }
}
