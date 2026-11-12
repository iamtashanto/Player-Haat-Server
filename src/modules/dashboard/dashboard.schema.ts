import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const dashboardQuery = z.object({
  role: z.enum(["PLAYER", "RECRUITER"]).optional().openapi({ description: "Which dashboard to build. Defaults to the signed-in role; a person with both profiles passes the one they are acting as." }),
});

const Completeness = z.object({ percent: z.number().int(), missing: z.array(z.string()).openapi({ description: "What is left to do, as short names (photo, cover, bio, gallery, video, availability, achievement, verification; organization, sports, firstGame for organisers)." }) });
const Rating = z.object({ average: z.number(), count: z.number().int(), isNew: z.boolean() });
const Game = z.object({ id: z.string(), title: z.string().nullable(), venueText: z.string(), matchAt: z.string().datetime(), kind: z.enum(["MATCH", "EVENT"]), sport: z.object({ nameBn: z.string(), nameEn: z.string() }) });

const PlayerDashboard = z
  .object({
    role: z.literal("PLAYER"),
    profile: z.object({ exists: z.boolean(), visible: z.boolean(), hiddenByAdmin: z.boolean(), verified: z.boolean(), completeness: Completeness }),
    reliability: z.object({ gamesPlayed: z.number().int(), noShows: z.number().int(), attendanceRate: z.number().nullable() }),
    rating: Rating,
    reviewsToGive: z.number().int(),
    reviewsNewThisWeek: z.number().int(),
    upcoming: z.array(Game).openapi({ description: "Games I am accepted into, soonest first (max 5)." }),
    applications: z.object({ pending: z.number().int() }),
    invites: z.object({ pending: z.number().int() }),
    views: z.object({ last7Days: z.number().int() }),
    credits: z.number().int(),
  })
  .openapi("PlayerDashboard");

const RecruiterDashboard = z
  .object({
    role: z.literal("RECRUITER"),
    profile: z.object({ exists: z.boolean(), id: z.string().nullable().openapi({ description: "The organiser profile id (for linking to the public card, where the logo is set)." }), verified: z.boolean(), completeness: Completeness }),
    games: z.object({
      open: z.number().int(),
      upcoming: z.array(Game.extend({ playersNeeded: z.number().int(), playersAccepted: z.number().int(), pendingApplicants: z.number().int() })),
      needAttendance: z.array(Game.extend({ unmarked: z.number().int() })).openapi({ description: "Played games with accepted players not yet marked turned-up / no-show (inside the 14-day marking window)." }),
    }),
    applicants: z.object({ pending: z.number().int() }),
    reviewsToGive: z.number().int(),
    rating: Rating,
    stats90: z.object({ gamesHosted: z.number().int(), fillRate: z.number().nullable(), noShowRate: z.number().nullable() }).openapi({ description: "Last 90 days. Rates are 0 to 1, or null when there is nothing to divide by." }),
    shortlist: z.object({ count: z.number().int() }),
    invites: z.object({ pending: z.number().int(), accepted: z.number().int() }),
    credits: z.number().int(),
  })
  .openapi("RecruiterDashboard");

registerRoute({
  method: "get",
  path: "/dashboard",
  tag: "Dashboard",
  summary: "My dashboard",
  description: "One call with everything the home dashboard needs for the role I am acting as: upcoming games, what needs my attention, reliability, rating, profile completeness. Players and organisers get different shapes (`role` tells them apart).",
  auth: true,
  query: dashboardQuery,
  response: z.union([PlayerDashboard, RecruiterDashboard]),
  errors: [403],
});
