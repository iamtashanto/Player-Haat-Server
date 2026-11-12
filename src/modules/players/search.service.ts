import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { availableNowSql } from "./availability.service.js";
import { cardExtras } from "./reliability.service.js";
import { shortlistedAmong } from "../shortlist/shortlist.service.js";
import { profileInclude, toPlayerCard } from "./players.presenter.js";
import type { searchQuery } from "./players.schema.js";

type Query = z.infer<typeof searchQuery>;

interface Row {
  id: string;
  bayesRating: number;
  ratingCount: number;
  lastActiveAt: Date;
  matchedSportIds: number[];
  prox: number;
}

// ── opaque cursor: the sort keys of the last row returned ──
type Cursor = { s: "rating"; v: [number, number, string] } | { s: "active"; v: [string, string] } | { s: "near"; v: [number, number, number, string] };

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string, sort: Query["sort"]): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString()) as Cursor;
    const ok =
      c.s === sort &&
      (c.s === "rating"
        ? typeof c.v[0] === "number" && typeof c.v[1] === "number" && typeof c.v[2] === "string"
        : c.s === "near"
          ? typeof c.v[0] === "number" && typeof c.v[1] === "number" && typeof c.v[2] === "number" && typeof c.v[3] === "string"
          : typeof c.v[0] === "string" && !Number.isNaN(Date.parse(c.v[0])) && typeof c.v[1] === "string");
    if (ok) return c;
  } catch {
    /* fall through */
  }
  throw AppError.invalid("cursor", "Invalid or mismatched cursor");
}

const rowCursor = (sort: Query["sort"], r: Row): Cursor =>
  sort === "rating"
    ? { s: "rating", v: [r.bayesRating, r.ratingCount, r.id] }
    : sort === "near"
      ? { s: "near", v: [Number(r.prox), r.bayesRating, r.ratingCount, r.id] }
      : { s: "active", v: [r.lastActiveAt.toISOString(), r.id] };

/**
 * Raw SQL (not Prisma's query builder) because the filters need things it can't express well:
 * an EXISTS over one sport row with array-contains (GIN index), a JSONB day check, and keyset
 * pagination over mixed-direction sort keys. Every value is a bound parameter.
 *
 * Sort orders (all end in `id ASC` as a unique tie-breaker so pages never overlap or skip):
 *   rating: bayesRating DESC, ratingCount DESC, id      — uses PlayerProfile_bayesRating_ratingCount_idx
 *   active: lastActiveAt DESC, id                     — uses PlayerProfile_lastActiveAt_idx
 */
/** Builds the (parameterised) id-selection query. Exported so scripts can EXPLAIN exactly what runs. */
export function buildSearchSql(viewerId: string, q: Query): Prisma.Sql {
  const where: Prisma.Sql[] = [
    Prisma.sql`p."isVisible" = true`,
    Prisma.sql`p."hiddenByAdminAt" IS NULL`,
    Prisma.sql`u.status = 'ACTIVE'`,
    Prisma.sql`u.role = 'PLAYER'`, // an account switched to another role drops out of discovery
    Prisma.sql`p."userId" <> ${viewerId}`,
  ];

  if (q.districtId !== undefined) where.push(Prisma.sql`p."districtId" = ${q.districtId}`);
  if (q.upazilaId !== undefined) where.push(Prisma.sql`p."upazilaId" = ${q.upazilaId}`);
  if (q.availableToday) where.push(availableNowSql(q.sportId, new Date()));
  if (q.unionId !== undefined) where.push(Prisma.sql`p."unionId" = ${q.unionId}`);
  if (q.q) where.push(Prisma.sql`u.name ILIKE ${`%${q.q.replace(/[\\%_]/g, "\\$&")}%`}`);
  // With a sport chosen, "rated 4+" means rated 4+ *in that sport*; otherwise the overall rating decides.
  if (q.minRating !== undefined && q.sportId === undefined) where.push(Prisma.sql`p."avgRating" >= ${q.minRating} AND p."ratingCount" > 0`);

  if (q.minReviews !== undefined && q.sportId === undefined) where.push(Prisma.sql`p."ratingCount" >= ${q.minReviews}`);

  // All sport-level conditions must hold on the SAME PlayerSport row.
  const sport: Prisma.Sql[] = [];
  if (q.sportId !== undefined) sport.push(Prisma.sql`ps."sportId" = ${q.sportId}`);
  if (q.minRating !== undefined && q.sportId !== undefined) sport.push(Prisma.sql`ps."avgRating" >= ${q.minRating} AND ps."ratingCount" > 0`);
  if (q.minReviews !== undefined && q.sportId !== undefined) sport.push(Prisma.sql`ps."ratingCount" >= ${q.minReviews}`);
  if (q.minExperienceYears !== undefined) sport.push(Prisma.sql`ps."experienceYears" >= ${q.minExperienceYears}`);
  if (q.minSkillLevel !== undefined) sport.push(Prisma.sql`ps."skillLevel" >= ${q.minSkillLevel}`);
  if (q.statsVerified === true) sport.push(Prisma.sql`ps."statsVerifiedAt" IS NOT NULL`);
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
  // Sport profiles the player or an admin has hidden never match. (Only enforced when a sport-level
  // filter is in play: a player with no matching filter is still found by name/place via the account.)
  const sportMatch = sport.length
    ? Prisma.sql`ps."isVisible" = true AND ps."hiddenByAdminAt" IS NULL AND ${Prisma.join(sport, " AND ")}`
    : undefined;
  if (sportMatch) {
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM "PlayerSport" ps WHERE ps."profileId" = p.id AND ${sportMatch})`);
  }
  // Which of this player's sport profiles matched, so the card can lead with the relevant one.
  const matched = sportMatch
    ? Prisma.sql`ARRAY(SELECT ps."sportId" FROM "PlayerSport" ps WHERE ps."profileId" = p.id AND ${sportMatch})`
    : Prisma.sql`ARRAY[]::int[]`;

  // Proximity rank of a profile to the viewer's detected area (area ids only; no coordinates).
  const prox =
    q.sort === "near"
      ? Prisma.sql`(CASE WHEN ${q.nearUnionId ?? null}::int IS NOT NULL AND p."unionId" = ${q.nearUnionId ?? null}::int THEN 0 WHEN ${q.nearUpazilaId ?? null}::int IS NOT NULL AND p."upazilaId" = ${q.nearUpazilaId ?? null}::int THEN 1 WHEN p."districtId" = ${q.nearDistrictId ?? null}::int THEN 2 ELSE 3 END)`
      : Prisma.sql`0`;

  if (q.cursor) {
    const c = decode(q.cursor, q.sort);
    if (c.s === "near") {
      const [rank, avg, cnt, id] = c.v;
      where.push(
        Prisma.sql`(${prox} > ${rank} OR (${prox} = ${rank} AND (p."bayesRating" < ${avg} OR (p."bayesRating" = ${avg} AND (p."ratingCount" < ${cnt} OR (p."ratingCount" = ${cnt} AND p.id > ${id}))))))`,
      );
    } else if (c.s === "rating") {
      const [avg, cnt, id] = c.v;
      where.push(
        Prisma.sql`(p."bayesRating" < ${avg} OR (p."bayesRating" = ${avg} AND (p."ratingCount" < ${cnt} OR (p."ratingCount" = ${cnt} AND p.id > ${id}))))`,
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
      ? Prisma.sql`p."bayesRating" DESC, p."ratingCount" DESC, p.id ASC`
      : q.sort === "near"
        ? Prisma.sql`${prox} ASC, p."bayesRating" DESC, p."ratingCount" DESC, p.id ASC`
        : Prisma.sql`p."lastActiveAt" DESC, p.id ASC`;

  return Prisma.sql`
    SELECT p.id, p."bayesRating", p."ratingCount", p."lastActiveAt", ${matched} AS "matchedSportIds", ${prox} AS prox
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
  const saved = await shortlistedAmong(viewerId, page.map((r) => r.id));
  const extras = await cardExtras(profiles);
  const items = page.flatMap((r) => (byId.has(r.id) ? [toPlayerCard(byId.get(r.id)!, r.matchedSportIds, saved.has(r.id), extras)] : []));

  return { items, nextCursor: hasMore ? encode(rowCursor(q.sort, page[page.length - 1]!)) : null };
}
