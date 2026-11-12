import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const MAX_ACTIVE_PER_ORGANISER = 5;
const id = z.string().min(1).max(40);
const intId = z.number().int().positive();
const qid = z.coerce.number().int().positive();

export const createTournamentBody = z.strictObject({
  name: z.string().trim().min(3).max(80),
  sportId: intId,
  districtId: intId,
  upazilaId: intId,
  venueText: z.string().trim().max(200).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).openapi({ description: "When the first round is planned; must be in the future." }),
  maxTeams: z.union([z.literal(4), z.literal(8), z.literal(16)]).openapi({ description: "4, 8 or 16 teams. With fewer registered teams the top seeds get byes." }),
});
export const tournamentParams = z.object({ id });
export const entryParams = z.object({ id, teamId: id });
export const matchParams = z.object({ id, matchId: id });
export const registerBody = z.strictObject({ teamId: id });
export const scoreBody = z.strictObject({
  homeScore: z.number().int().min(0).max(999),
  awayScore: z.number().int().min(0).max(999),
  winner: z.enum(["HOME", "AWAY"]).optional().openapi({ description: "Needed only when the score is level (penalties or a toss)." }),
});
export const tournamentsQuery = pageQuery.extend({
  sportId: qid.optional(),
  upazilaId: qid.optional(),
  districtId: qid.optional(),
  status: z.enum(["REGISTRATION", "RUNNING", "FINISHED"]).optional(),
});

const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const TeamLite = z.object({ id: z.string(), name: z.string(), logoUrl: z.string().nullable() });
const Match = z.object({
  id: z.string(),
  round: z.number().int(),
  slot: z.number().int(),
  home: TeamLite.nullable(),
  away: TeamLite.nullable(),
  homeScore: z.number().int().nullable(),
  awayScore: z.number().int().nullable(),
  winnerTeamId: z.string().nullable(),
  isBye: z.boolean().openapi({ description: "A first-round slot with no opponent: the team moves on." }),
});
const Tournament = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["REGISTRATION", "RUNNING", "FINISHED", "CANCELLED"]),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    location: z.object({ district: Ref, upazila: Ref }),
    venueText: z.string().nullable(),
    startsAt: z.string().datetime(),
    maxTeams: z.number().int(),
    teamCount: z.number().int(),
    organiser: z.object({ name: z.string() }),
    champion: TeamLite.nullable(),
    isOwner: z.boolean(),
    teams: z.array(TeamLite),
    rounds: z.number().int().openapi({ description: "Number of rounds once started (0 before)." }),
    matches: z.array(Match),
    myTeams: z.array(z.object({ id: z.string(), name: z.string(), registered: z.boolean() })).openapi({ description: "Teams I captain that play this sport, and whether each is entered. Empty when signed out." }),
  })
  .openapi("Tournament");

const T = "Tournaments";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/tournaments", ...A, summary: "Create a knockout tournament", description: `Anyone can organise. Up to ${MAX_ACTIVE_PER_ORGANISER} active tournaments each. Team captains register until you start it.`, body: createTournamentBody, response: Tournament, status: 201, errors: [409, 422] });
registerRoute({ method: "get", path: "/tournaments", ...A, summary: "Tournaments", query: tournamentsQuery, response: z.array(Tournament), errors: [422] });
registerRoute({ method: "get", path: "/tournaments/{id}", ...A, summary: "One tournament with its bracket", params: tournamentParams, response: Tournament, errors: [404] });
registerRoute({ method: "post", path: "/tournaments/{id}/teams", ...A, summary: "Enter a team (captain)", description: "Only while registration is open, for a team of the same sport, until the tournament is full.", params: tournamentParams, body: registerBody, response: Tournament, errors: [404, 409, 422] });
registerRoute({ method: "delete", path: "/tournaments/{id}/teams/{teamId}", ...A, summary: "Take a team out (its captain, or the organiser)", description: "Only before the tournament starts.", params: entryParams, response: Tournament, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/tournaments/{id}/start", ...A, summary: "Start: draw the bracket (organiser)", description: "Needs at least 4 teams. The draw is random; with fewer teams than the bracket holds, some get byes.", params: tournamentParams, response: Tournament, errors: [403, 404, 409] });
registerRoute({ method: "put", path: "/tournaments/{id}/matches/{matchId}", ...A, summary: "Enter a match score (organiser)", description: "Both teams must be known. The winner moves to the next round. A score can be corrected until the next match has been played.", params: matchParams, body: scoreBody, response: Tournament, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/tournaments/{id}/cancel", ...A, summary: "Cancel the tournament (organiser)", params: tournamentParams, response: Tournament, errors: [403, 404, 409] });
registerRoute({ method: "get", path: "/public/tournaments", tag: "Public", summary: "Tournaments (signed out)", query: tournamentsQuery, response: z.array(Tournament), errors: [422] });
registerRoute({ method: "get", path: "/public/tournaments/{id}", tag: "Public", summary: "One tournament with its bracket (signed out)", params: tournamentParams, response: Tournament, errors: [404] });
