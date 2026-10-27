import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { profileInclude, toPlayerCard } from "./players.presenter.js";
import type { searchQuery } from "./players.schema.js";

type Query = z.infer<typeof searchQuery>;

interface Row {
  id: string;
  avgRating: number;
  ratingCount: number;
  lastActiveAt: Date;
}

// ── opaque cursor: the sort keys of the last row returned ──
type Cursor = { s: "rating"; v: [number, number, string] } | { s: "active"; v: [string, string] };

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string, sort: Query["sort"]): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString()) as Cursor;
    const ok =
      c.s === sort &&
      (c.s === "rating"
        ? typeof c.v[0] === "number" && typeof c.v[1] === "number" && typeof c.v[2] === "string"
        : typeof c.v[0] === "string" && !Number.isNaN(Date.parse(c.v[0])) && typeof c.v[1] === "string");
    if (ok) return c;
  } catch {
    /* fall through */
  }
  throw AppError.invalid("cursor", "Invalid or mismatched cursor");
}

const rowCursor = (sort: Query["sort"], r: Row): Cursor =>
  sort === "rating"
    ? { s: "rating", v: [r.avgRating, r.ratingCount, r.id] }
    : { s: "active", v: [r.lastActiveAt.toISOString(), r.id] };

/**
 * Raw SQL (not Prisma's query builder) because the filters need things it can't express well:
 * an EXISTS over one sport row with array-contains (GIN index), a JSONB day check, and keyset
 * pagination over mixed-direction sort keys. Every value is a bound parameter.
 *
 * Sort orders (all end in `id ASC` as a unique tie-breaker so pages never overlap or skip):
 *   rating: avgRating DESC, ratingCount DESC, id      — uses PlayerProfile_avgRating_ratingCount_idx
 *   active: lastActiveAt DESC, id                     — uses PlayerProfile_lastActiveAt_idx
 */
/** Builds the (parameterised) id-selection query. Exported so scripts can EXPLAIN exactly what runs. */
export function buildSearchSql(viewerId: string, q: Query): Prisma.Sql {
  const where: Prisma.Sql[] = [
    Prisma.sql`p."isVisible" = true`,
    Prisma.sql`p."hiddenByAdminAt" IS NULL`,
    Prisma.sql`u.status = 'ACTIVE'`,
    Prisma.sql`p."userId" <> ${viewerId}`,
  ];

  if (q.districtId !== undefined) where.push(Prisma.sql`p."districtId" = ${q.districtId}`);
  if (q.upazilaId !== undefined) where.push(Prisma.sql`p."upazilaId" = ${q.upazilaId}`);
  if (q.unionId !== undefined) where.push(Prisma.sql`p."unionId" = ${q.unionId}`);
  if (q.minRating !== undefined) where.push(Prisma.sql`p."avgRating" >= ${q.minRating} AND p."ratingCount" > 0`);

  // All sport-level conditions must hold on the SAME PlayerSport row.
  const sport: Prisma.Sql[] = [];
  if (q.sportId !== undefined) sport.push(Prisma.sql`ps."sportId" = ${q.sportId}`);
  if (q.position) sport.push(Prisma.sql`ps.positions @> ARRAY[${q.position}]::text[]`);
  if (q.khepAvailable !== undefined) sport.push(Prisma.sql`ps."khepAvailable" = ${q.khepAvailable}`);
  // Rates only mean something for khep (paid) players, so a budget filter implies khepAvailable.
  // The budget [rateMin, rateMax] must overlap the player's range; a missing bound means "negotiable".
  if ((q.rateMin !== undefined || q.rateMax !== undefined) && q.khepAvailable === undefined) {
    sport.push(Prisma.sql`ps."khepAvailable" = true`);
  }
  if (q.rateMax !== undefined) sport.push(Prisma.sql`(ps."rateMin" IS NULL OR ps."rateMin" <= ${q.rateMax})`);
  if (q.rateMin !== undefined) sport.push(Prisma.sql`(ps."rateMax" IS NULL OR ps."rateMax" >= ${q.rateMin})`);
  if (q.availabilityDay) {
    sport.push(Prisma.sql`jsonb_array_length(COALESCE(ps.availability -> ${q.availabilityDay}::text, '[]'::jsonb)) > 0`);
  }
  if (sport.length) {
    where.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "PlayerSport" ps WHERE ps."profileId" = p.id AND ${Prisma.join(sport, " AND ")})`,
    );
  }

  if (q.cursor) {
    const c = decode(q.cursor, q.sort);
    if (c.s === "rating") {
      const [avg, cnt, id] = c.v;
      where.push(
        Prisma.sql`(p."avgRating" < ${avg} OR (p."avgRating" = ${avg} AND (p."ratingCount" < ${cnt} OR (p."ratingCount" = ${cnt} AND p.id > ${id}))))`,
      );
    } else {
      const [at, id] = c.v;
      // Columns are `timestamp without time zone` holding UTC. Binding a JS Date would make Postgres
      // reinterpret it in the *session* time zone (skewing the cursor by hours on non-UTC servers),
      // so send the UTC wall-clock text and cast it to the same type as the column.
      const utc = new Date(at).toISOString();
      where.push(Prisma.sql`(p."lastActiveAt" < ${utc}::timestamp OR (p."lastActiveAt" = ${utc}::timestamp AND p.id > ${id}))`);
    }
  }

  const orderBy =
    q.sort === "rating"
      ? Prisma.sql`p."avgRating" DESC, p."ratingCount" DESC, p.id ASC`
      : Prisma.sql`p."lastActiveAt" DESC, p.id ASC`;

  return Prisma.sql`
    SELECT p.id, p."avgRating", p."ratingCount", p."lastActiveAt"
    FROM "PlayerProfile" p
    JOIN "User" u ON u.id = p."userId"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY ${orderBy}
    LIMIT ${q.limit + 1}`;
}

export async function searchPlayers(viewerId: string, q: Query) {
  const rows = await prisma.$queryRaw<Row[]>(buildSearchSql(viewerId, q));

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  // Hydrate in one query, then restore the SQL order.
  const profiles = await prisma.playerProfile.findMany({
    where: { id: { in: page.map((r) => r.id) } },
    include: profileInclude,
  });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const items = page.flatMap((r) => (byId.has(r.id) ? [toPlayerCard(byId.get(r.id)!)] : []));

  return { items, nextCursor: hasMore ? encode(rowCursor(q.sort, page[page.length - 1]!)) : null };
}
