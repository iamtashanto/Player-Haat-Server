import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { requestInclude } from "./requests.presenter.js";

/**
 * Locks the request row for the rest of the transaction and returns its fresh state.
 * Accepting, withdrawing, editing, cancelling and completing all change `status` / `playersAccepted`,
 * so they serialize here — otherwise two captains' clicks (or one captain's double-tap) could
 * over-fill a match.
 */
export async function lockRequest(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PlayerRequest" WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  return tx.playerRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
}
