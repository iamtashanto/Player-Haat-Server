import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const qid = z.coerce.number().int().positive();
const id = z.string().min(1).max(40);
const period = z.enum(["season", "all"]).default("season").openapi({ description: "`season` is the current calendar quarter (Asia/Dhaka); `all` is every confirmed result." });

export const leaderboardQuery = z
  .object({ sportId: qid, upazilaId: qid.optional(), districtId: qid.optional(), period })
  .refine((q) => !(q.upazilaId && q.districtId), { message: "Pass upazilaId or districtId, not both", path: ["districtId"] });
export const publicTeamParams = z.object({ id: z.string().min(1).max(40) });
export const publicTeamQuery = z.object({ period: z.enum(["season", "all"]).default("all") });

const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const TeamLite = z.object({ id: z.string(), name: z.string(), logoUrl: z.string().nullable(), district: Ref, upazila: Ref });
const Line = { played: z.number().int(), won: z.number().int(), drawn: z.number().int(), lost: z.number().int(), gf: z.number().int(), ga: z.number().int(), goalDiff: z.number().int() };
const Leaderboard = z
  .object({
    season: z.object({ year: z.number().int(), quarter: z.number().int() }).nullable(),
    teams: z.array(z.object({ rank: z.number().int(), team: TeamLite, points: z.number().int(), ...Line })),
    players: z.array(z.object({ rank: z.number().int(), player: z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable(), upazila: Ref }), gamesPlayed: z.number().int() })),
  })
  .openapi("Leaderboard");
const PublicTeam = z
  .object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    location: z.object({ district: Ref, upazila: Ref }),
    memberCount: z.number().int(),
    foundedAt: z.string().datetime(),
    record: z.object({ ...Line, points: z.number().int() }),
    recent: z.array(z.object({ requestId: z.string(), matchAt: z.string().datetime(), venueText: z.string(), ourScore: z.number().int(), theirScore: z.number().int(), outcome: z.enum(["WIN", "DRAW", "LOSS"]), opponent: z.object({ id: z.string(), name: z.string() }).nullable() })),
  })
  .openapi("PublicTeam");

const T = "Public";
registerRoute({ method: "get", path: "/public/leaderboard", tag: T, summary: "Team standings and most-active players (signed out)", description: "Standings come from confirmed results only (3 points a win, 1 a draw). Players are ranked by games played, marked by organisers, among people with a visible profile.", query: leaderboardQuery as unknown as z.ZodObject, response: Leaderboard, errors: [422] });
registerRoute({ method: "get", path: "/public/teams/{id}", tag: T, summary: "A team's public page (signed out)", description: "Name, area, member count, record and latest confirmed results. No member names, no join code.", params: publicTeamParams, query: publicTeamQuery, response: PublicTeam, errors: [404] });

// ── challenges ("ম্যাচ চাই") ──
export const challengeBody = z.strictObject({
  teamId: id,
  proposedAt: z.string().datetime({ offset: true }).openapi({ description: "When you would like to play; must be in the future." }),
  venueText: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(300).nullable().optional(),
});
export const acceptBody = z.strictObject({ teamId: id.openapi({ description: "The team (that I captain) that takes the challenge. Same sport." }) });
export const challengeParams = z.object({ id });
export const challengesQuery = z.object({ sportId: qid.optional(), upazilaId: qid.optional(), districtId: qid.optional() });

const Challenge = z
  .object({
    id: z.string(),
    status: z.enum(["OPEN", "ACCEPTED", "CANCELLED"]),
    team: TeamLite,
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    venueText: z.string(),
    proposedAt: z.string().datetime(),
    notes: z.string().nullable(),
    isMine: z.boolean(),
    acceptedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    requestId: z.string().nullable().openapi({ description: "The match created when the challenge was accepted." }),
    createdAt: z.string().datetime(),
  })
  .openapi("TeamChallenge");
const C = "Challenges";
const A = { tag: C, auth: true } as const;
registerRoute({ method: "post", path: "/challenges", ...A, summary: "Challenge other teams (ম্যাচ চাই)", description: "Team captains only. At most 3 open challenges per team.", body: challengeBody, response: Challenge, status: 201, errors: [409, 422] });
registerRoute({ method: "get", path: "/challenges", ...A, summary: "Open challenges", description: "Upcoming and still open, soonest first. `isMine` marks my own.", query: challengesQuery, response: z.array(Challenge), errors: [422] });
registerRoute({ method: "get", path: "/challenges/mine", ...A, summary: "Challenges I made or accepted", response: z.array(Challenge) });
registerRoute({ method: "post", path: "/challenges/{id}/accept", ...A, summary: "Accept a challenge (captain of another team)", description: "Creates the match for the challenging team with your team as the opponent, and tells the challenger. Only one captain can accept.", params: challengeParams, body: acceptBody, response: Challenge, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/challenges/{id}/cancel", ...A, summary: "Withdraw my challenge", params: challengeParams, response: Challenge, errors: [403, 404, 409] });
