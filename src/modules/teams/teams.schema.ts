import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const MAX_TEAMS_PER_CAPTAIN = 5;
export const MAX_TEAM_MEMBERS = 40;

const intId = z.number().int().positive();
const id = z.string().min(1).max(40);
const name = z.string().trim().min(2).max(60);

export const createTeamBody = z.strictObject({ name, sportId: intId, districtId: intId, upazilaId: intId, unionId: intId.nullable().optional() });
export const updateTeamBody = z
  .strictObject({
    name,
    districtId: intId,
    upazilaId: intId,
    unionId: intId.nullable(),
    logoPublicId: z.string().min(10).max(300).nullable().openapi({ description: "From POST /media/images with type `team-logo`; null removes the logo." }),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field")
  .refine((b) => (b.districtId === undefined) === (b.upazilaId === undefined), { message: "districtId and upazilaId must be changed together", path: ["upazilaId"] });
export const joinBody = z.strictObject({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/, "Team codes are 8 letters and digits") });
export const teamParams = z.object({ id });
export const memberParams = z.object({ id, memberId: id });

const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const Team = z
  .object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    location: z.object({ district: Ref, upazila: Ref, union: Ref.nullable() }),
    memberCount: z.number().int(),
    captain: z.object({ name: z.string(), avatarUrl: z.string().nullable(), profileId: z.string().nullable(), recruiterId: z.string().nullable() }),
    isCaptain: z.boolean(),
    isMember: z.boolean(),
    joinCode: z.string().optional().openapi({ description: "Captain only. Share it; entering it joins the team." }),
    members: z.array(z.object({ memberId: z.string(), name: z.string(), avatarUrl: z.string().nullable(), role: z.enum(["CAPTAIN", "VICE_CAPTAIN", "PLAYER"]), profileId: z.string().nullable() })).optional().openapi({ description: "Detail view only." }),
  })
  .openapi("Team");

const T = "Teams";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/teams", ...A, summary: "Create a team", description: `You become its captain. Up to ${MAX_TEAMS_PER_CAPTAIN} teams per captain. Share the join code so players can join.`, body: createTeamBody, response: Team, status: 201, errors: [409, 422] });
registerRoute({ method: "get", path: "/teams/mine", ...A, summary: "Teams I captain or belong to", response: z.array(Team) });
registerRoute({ method: "post", path: "/teams/join", ...A, summary: "Join a team with its code (players)", body: joinBody, response: Team, errors: [403, 404, 409, 422, 429] });
registerRoute({ method: "get", path: "/teams/{id}", ...A, summary: "A team with its members", params: teamParams, response: Team, errors: [404] });
registerRoute({ method: "patch", path: "/teams/{id}", ...A, summary: "Edit my team (captain)", params: teamParams, body: updateTeamBody, response: Team, errors: [403, 404, 422] });
registerRoute({ method: "post", path: "/teams/{id}/join-code", ...A, summary: "Replace the join code (captain)", description: "The old code stops working at once. Existing members stay.", params: teamParams, response: Team, errors: [403, 404] });
registerRoute({ method: "post", path: "/teams/{id}/leave", ...A, summary: "Leave a team", params: teamParams, response: z.object({ left: z.boolean() }), errors: [404, 409] });
registerRoute({ method: "delete", path: "/teams/{id}/members/{memberId}", ...A, summary: "Remove a member (captain)", params: memberParams, response: Team, errors: [403, 404, 409] });
registerRoute({ method: "delete", path: "/teams/{id}", ...A, summary: "Delete my team (captain)", description: "Requests posted for it stay, without the team.", params: teamParams, response: z.object({ deleted: z.boolean() }), errors: [403, 404] });
