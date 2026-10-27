import type { Prisma } from "@prisma/client";
import type { NotifyInput } from "../notifications/notifier.js";
import { lockRequest } from "../requests/request-lock.js";
import type { RequestRow } from "../requests/requests.presenter.js";

type Tx = Prisma.TransactionClient;

const display = (r: RequestRow) => ({ sport: { bn: r.sport.nameBn, en: r.sport.nameEn }, venue: r.venueText, when: r.matchAt });

/**
 * Takes a user out of everything still in motion, when they are suspended or delete their account:
 *  - their upcoming OPEN/FILLED requests are CANCELLED (pending applicants rejected);
 *  - their PENDING applications are withdrawn;
 *  - their ACCEPTED applications on upcoming matches are withdrawn, freeing the spot (a FILLED request re-opens).
 * Finished matches and rating history are left alone. Returns the notifications to send after commit,
 * so the people on the other side find out instead of waiting for someone who isn't coming.
 */
export async function retireParticipation(tx: Tx, userId: string): Promise<NotifyInput[]> {
  const now = new Date();
  const effects: NotifyInput[] = [];

  // 1) requests they posted
  const posted = await tx.playerRequest.findMany({
    where: { createdById: userId, status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: now } },
    select: { id: true },
  });
  for (const { id } of posted) {
    const request = await lockRequest(tx, id);
    const audience = await tx.application.findMany({
      where: { requestId: id, status: { in: ["ACCEPTED", "PENDING"] } },
      select: { playerId: true },
    });
    await tx.application.updateMany({ where: { requestId: id, status: "PENDING" }, data: { status: "REJECTED", respondedAt: now } });
    await tx.playerRequest.update({ where: { id }, data: { status: "CANCELLED" } });
    effects.push({ userIds: audience.map((a) => a.playerId), type: "REQUEST_CANCELLED", data: { requestId: id }, params: display(request) });
  }

  // 2) applications they made to upcoming matches
  const applied = await tx.application.findMany({
    where: { playerId: userId, status: { in: ["PENDING", "ACCEPTED"] }, request: { status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: now } } },
    select: { id: true, status: true, requestId: true, player: { select: { name: true } } },
  });
  for (const a of applied) {
    const request = await lockRequest(tx, a.requestId);
    await tx.application.update({ where: { id: a.id }, data: { status: "WITHDRAWN", respondedAt: now } });
    if (a.status === "ACCEPTED") {
      const accepted = Math.max(0, request.playersAccepted - 1);
      await tx.playerRequest.update({
        where: { id: request.id },
        data: { playersAccepted: accepted, ...(request.status === "FILLED" && accepted < request.playersNeeded && { status: "OPEN" }) },
      });
      effects.push({
        userIds: [request.createdById],
        type: "APPLICATION_WITHDRAWN",
        data: { requestId: request.id, applicationId: a.id },
        params: { ...display(request), actor: a.player.name },
      });
    }
  }
  return effects;
}
