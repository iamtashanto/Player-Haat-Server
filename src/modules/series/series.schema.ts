import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const MAX_SERIES_PER_ORGANISER = 5;

const id = z.string().min(1).max(40);
export const seriesParams = z.object({ id });
export const repeatBody = z
  .strictObject({ title: z.string().trim().min(2).max(60).openapi({ description: 'What the regulars call it, e.g. "Friday football".' }) })
  .default({ title: "" });
export const repeatParams = z.object({ requestId: id });
export const updateSeriesBody = z
  .strictObject({
    title: z.string().trim().min(2).max(60),
    isActive: z.boolean().openapi({ description: "false pauses the series: no new game is posted until it is resumed." }),
    playersNeeded: z.number().int().min(1).max(30),
    notes: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field");

const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const Game = z.object({ id: z.string(), matchAt: z.string().datetime(), status: z.enum(["OPEN", "FILLED", "CANCELLED", "COMPLETED"]), spotsLeft: z.number().int() });
const Series = z
  .object({
    id: z.string(),
    title: z.string(),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    location: z.object({ district: Ref, upazila: Ref, union: Ref.nullable() }),
    venueText: z.string(),
    weekday: z.number().int().openapi({ description: "0 = Sunday … 6 = Saturday, Asia/Dhaka." }),
    startTime: z.string().openapi({ description: "HH:MM, Asia/Dhaka." }),
    playersNeeded: z.number().int(),
    joinMode: z.enum(["APPROVAL", "OPEN_JOIN"]),
    isPaid: z.boolean(),
    isActive: z.boolean(),
    regularsCount: z.number().int(),
    isOwner: z.boolean(),
    isRegular: z.boolean(),
    organiser: z.object({ name: z.string(), avatarUrl: z.string().nullable() }),
    nextGame: Game.nullable().openapi({ description: "The upcoming game, if one is posted." }),
    recentGames: z.array(Game).openapi({ description: "Up to 5 earlier games, latest first." }),
  })
  .openapi("GameSeries");

const T = "Series";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/series/from-request/{requestId}", ...A, summary: "Make a game weekly (organiser)", description: `Turns one of my matches into a weekly series: same ground, day and time. The next game is posted by itself once the last has started. Up to ${MAX_SERIES_PER_ORGANISER} series.`, params: repeatParams, body: repeatBody, response: Series, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/series/mine", ...A, summary: "Series I run or am a regular in", response: z.array(Series) });
registerRoute({ method: "get", path: "/series/{id}", ...A, summary: "A weekly game", params: seriesParams, response: Series, errors: [404] });
registerRoute({ method: "patch", path: "/series/{id}", ...A, summary: "Edit, pause or resume my series", params: seriesParams, body: updateSeriesBody, response: Series, errors: [403, 404, 422] });
registerRoute({ method: "post", path: "/series/{id}/regulars", ...A, summary: "Become a regular", description: "Regulars are told when each week's game is posted. You still apply to each game.", params: seriesParams, response: Series, errors: [403, 404, 409] });
registerRoute({ method: "delete", path: "/series/{id}/regulars", ...A, summary: "Stop being a regular", params: seriesParams, response: Series, errors: [404] });
