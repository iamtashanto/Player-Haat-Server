import { PAGINATION } from "../config/constants.js";
import { AppError } from "./errors.js";
import { z } from "./zod.js";

/** `?cursor=&limit=` shared by every cursor-paginated list. */
export const pageQuery = z.object({
  cursor: z.string().max(200).optional().openapi({ description: "Opaque; pass `meta.nextCursor` from the previous page." }),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).default(PAGINATION.defaultLimit),
});

export const encodeCursor = (id: string) => Buffer.from(id, "utf8").toString("base64url");

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!id || id.length > 100 || encodeCursor(id) !== cursor) throw AppError.invalid("cursor", "Invalid cursor");
  return id;
}

/**
 * Prisma keyset pagination: spread into findMany, ordering by a unique-tiebroken `orderBy`
 * (always end it with `{ id: ... }`). Fetches one extra row to learn whether another page exists.
 */
export function cursorArgs(cursor: string | undefined, limit: number) {
  return { take: limit + 1, ...(cursor && { cursor: { id: decodeCursor(cursor) }, skip: 1 }) };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items[items.length - 1]!.id) : null };
}
