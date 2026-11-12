import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const SLOTS = ["morning", "afternoon", "evening", "night"] as const;
/** Gallery photos per player; videos per sports profile. */
export const MAX_PHOTOS = 12;
export const MAX_VIDEOS = 6;

const id = z.coerce.number().int().positive();
const intId = z.number().int().positive();

// ───────── profile ─────────
const bio = z.string().trim().max(500).nullable();
export const createProfileBody = z.strictObject({
  bio: bio.optional(),
  districtId: intId,
  upazilaId: intId,
  unionId: intId.nullable().optional(),
  isVisible: z.boolean().optional(),
  contactVisibility: z.enum(["ON_TAP", "AFTER_ACCEPT"]).optional(),
});
export const updateProfileBody = z
  .strictObject({
    bio,
    districtId: intId,
    upazilaId: intId,
    unionId: intId.nullable(),
    isVisible: z.boolean(),
    contactVisibility: z.enum(["ON_TAP", "AFTER_ACCEPT"]).openapi({ description: "ON_TAP (default): anyone signed in can tap to see your number. AFTER_ACCEPT: only people you've accepted." }),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field")
  .refine((b) => (b.districtId === undefined) === (b.upazilaId === undefined), {
    message: "districtId and upazilaId must be changed together",
    path: ["upazilaId"],
  });

// ───────── sports ─────────
const availability = z
  .partialRecord(z.enum(WEEKDAYS), z.array(z.enum(SLOTS)).max(SLOTS.length))
  .openapi({ example: { fri: ["afternoon", "evening"], sat: ["morning"] }, description: "Weekday → time slots." });
const rate = z.number().int().min(0).max(1_000_000);

const sportFields = {
  headline: z.string().trim().min(1).max(160),
  experienceYears: z.number().int().min(0).max(60),
  currentTeam: z.string().trim().min(1).max(80),
  stats: z.record(z.string(), z.number()).openapi({ example: { matches: 40, goals: 12, assists: 7 }, description: "Self-declared numbers; allowed keys depend on the sport (football: matches, goals, assists, cleanSheets · cricket: matches, runs, wickets, highestScore, battingAverage)." }),
  isVisible: z.boolean().openapi({ description: "Hide just this sport profile from search and public view." }),
  positions: z.array(z.string().trim().min(1).max(20)).min(1).max(4),
  preferredFoot: z.enum(["LEFT", "RIGHT", "BOTH"]).nullable(),
  battingStyle: z.enum(["RIGHT_HAND", "LEFT_HAND"]).nullable(),
  skillLevel: z.number().int().min(1).max(5),
  khepAvailable: z.boolean(),
  rateMin: rate.nullable(),
  rateMax: rate.nullable(),
  availability: availability.nullable(),
  travelRadius: z.enum(["UNION", "UPAZILA", "DISTRICT"]),
};
export const addSportBody = z.strictObject({
  sportId: intId,
  positions: sportFields.positions,
  skillLevel: sportFields.skillLevel,
  preferredFoot: sportFields.preferredFoot.optional(),
  battingStyle: sportFields.battingStyle.optional(),
  khepAvailable: sportFields.khepAvailable.optional(),
  rateMin: sportFields.rateMin.optional(),
  rateMax: sportFields.rateMax.optional(),
  availability: sportFields.availability.optional(),
  travelRadius: sportFields.travelRadius.optional(),
  headline: sportFields.headline.nullable().optional(),
  experienceYears: sportFields.experienceYears.nullable().optional(),
  currentTeam: sportFields.currentTeam.nullable().optional(),
  stats: sportFields.stats.nullable().optional(),
  isVisible: sportFields.isVisible.optional(),
});
export const updateSportBody = z
  .strictObject({
    ...sportFields,
    headline: sportFields.headline.nullable(),
    experienceYears: sportFields.experienceYears.nullable(),
    currentTeam: sportFields.currentTeam.nullable(),
    stats: sportFields.stats.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field");
export const sportParams = z.object({ sportId: id });

// ───────── achievements ─────────
export const MAX_ACHIEVEMENTS = 20;
export const addAchievementBody = z.strictObject({
  title: z.string().trim().min(1).max(100),
  year: z.number().int().min(1950).max(new Date().getUTCFullYear() + 1).nullable().optional(),
  description: z.string().trim().min(1).max(300).nullable().optional(),
});
export const achievementParams = z.object({ sportId: id, achievementId: z.string().min(1).max(40) });

// ───────── media ─────────
export const addVideoBody = z.strictObject({
  sportId: z.number().int().positive().openapi({ description: "The sports profile this video belongs to." }),
  source: z.enum(["YOUTUBE", "UPLOAD"]).default("YOUTUBE").openapi({ description: "`UPLOAD` (our own hosting) is not available yet: it answers 400 `UPLOAD_NOT_AVAILABLE`." }),
  url: z.string().trim().min(1).max(500).openapi({ description: "Any YouTube link (watch, youtu.be, shorts, embed) or the bare 11-character video id." }),
  caption: z.string().trim().max(120).nullable().optional(),
});
export const updateMediaBody = z.strictObject({ caption: z.string().trim().max(120).nullable() });
export const mediaParams = z.object({ mediaId: z.string().min(1).max(40) });
export const reorderBody = z.strictObject({ ids: z.array(z.string().min(1).max(40)).min(1).max(MAX_PHOTOS).openapi({ description: "Every gallery photo id exactly once, in the new order." }) });
export const profileParams = z.object({ id: z.string().min(1).max(40) });

// ───────── search ─────────
export const searchQuery = z
  .object({
    sportId: id.optional(),
    position: z.string().trim().min(1).max(20).optional().openapi({ description: "Position code; requires sportId." }),
    districtId: id.optional(),
    upazilaId: id.optional(),
    unionId: id.optional(),
    khepAvailable: z.stringbool().optional(),
    rateMin: z.coerce.number().int().min(0).optional().openapi({ description: "Your budget floor (BDT). Implies khepAvailable; khep players with no stated rate count as negotiable and match." }),
    rateMax: z.coerce.number().int().min(0).optional().openapi({ description: "Your budget ceiling (BDT)." }),
    minReviews: z.coerce.number().int().min(0).max(100).optional().openapi({ description: "Only players with at least this many revealed reviews (with `sportId`: in that sport). Used for \"top rated\" lists so they never rank people nobody has rated." }),
    minRating: z.coerce.number().min(0).max(5).optional().openapi({ description: "Excludes unrated players. With `sportId` it applies to that sport's own rating, otherwise to the overall one." }),
    minExperienceYears: z.coerce.number().int().min(0).max(60).optional().openapi({ description: "Matched against the same sport profile as the other sport-level filters." }),
    minSkillLevel: z.coerce.number().int().min(1).max(5).optional(),
    statsVerified: z.stringbool().optional().openapi({ description: "true = only sport profiles whose stats an admin has verified." }),
    q: z.string().trim().min(2).max(60).optional().openapi({ description: "Part of the player's name." }),
    availabilityDay: z.enum(WEEKDAYS).optional(),
    sort: z.enum(["rating", "active", "near"]).default("rating").openapi({ description: "`near` ranks same union, then same upazila, then same district, then the rest (rating breaks ties); needs `nearDistrictId`. The client passes the area ids it detected: no coordinates are sent or stored." }),
    availableToday: z.stringbool().optional().openapi({ description: "true = only players who marked themselves available right now (with `sportId`, for that sport)." }),
    nearDistrictId: id.optional(),
    nearUpazilaId: id.optional(),
    nearUnionId: id.optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((q) => !q.position || q.sportId !== undefined, { message: "position requires sportId", path: ["position"] })
  .refine((q) => q.sort !== "near" || q.nearDistrictId !== undefined, { message: "sort=near requires nearDistrictId", path: ["nearDistrictId"] })
  .refine((q) => q.rateMin === undefined || q.rateMax === undefined || q.rateMin <= q.rateMax, {
    message: "rateMin must be ≤ rateMax",
    path: ["rateMin"],
  });

// ───────── OpenAPI ─────────
const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const SportEntry = z.object({
  sportId: z.number(),
  sportCode: z.string(),
  positions: z.array(z.string()),
  skillLevel: z.number().int(),
  khepAvailable: z.boolean(),
  rateMin: z.number().nullable(),
  rateMax: z.number().nullable(),
  travelRadius: z.enum(["UNION", "UPAZILA", "DISTRICT"]),
  headline: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  currentTeam: z.string().nullable(),
  stats: z.record(z.string(), z.number()).nullable(),
  rating: z.object({ average: z.number(), count: z.number().int(), isNew: z.boolean() }),
  statsVerified: z.boolean().openapi({ description: "An admin checked these stats against the player's evidence." }),
  achievements: z.array(z.object({ id: z.string(), title: z.string(), year: z.number().int().nullable(), description: z.string().nullable() })).optional(),
  preferredFoot: z.string().nullable().optional(),
  battingStyle: z.string().nullable().optional(),
  availability: z.record(z.string(), z.array(z.string())).nullable().optional(),
});
const Location = z.object({ district: Ref, upazila: Ref, union: Ref.nullable() });
const Rating = z.object({ average: z.number(), count: z.number().int(), isNew: z.boolean() });
const PlayerCard = z
  .object({
    id: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
    verifiedBadge: z.boolean(),
    rating: Rating,
    noShowCount: z.number().int(),
    lastActiveAt: z.string().datetime(),
    location: Location,
    sports: z.array(SportEntry),
    shortlisted: z.boolean().openapi({ description: "true when the signed-in recruiter has saved this player." }),
    reliability: z
      .object({
        gamesPlayed: z.number().int(),
        noShows: z.number().int(),
        attendanceRate: z.number().min(0).max(1).nullable().openapi({ description: "Attended ÷ games the organiser marked; null until a game has been marked." }),
        ratingAverage: z.number(),
        ratingCount: z.number().int(),
      })
      .openapi({ description: "Shown the same everywhere a player appears: games played, attendance, no-shows and average rating." }),
    availableToday: z.boolean().openapi({ description: "true while the player's \"available today\" window is open." }),
    matchedSportIds: z.array(z.number().int()).openapi({ description: "Search only: the sport profiles that satisfied the sport-level filters (empty when none were used)." }),
  })
  .openapi("PlayerCard");
const MediaItem = z.object({
  id: z.string(),
  type: z.enum(["PHOTO", "VIDEO_LINK"]),
  url: z.string().openapi({ description: "Photos: delivery URL of the original. Videos: the watch link." }),
  thumbnailUrl: z.string().nullable().openapi({ description: "Photos: a 400px-wide rendition. Videos: the YouTube thumbnail." }),
  order: z.number().int(),
  caption: z.string().nullable(),
  source: z.enum(["YOUTUBE", "UPLOAD"]).nullable(),
  videoId: z.string().nullable(),
  sportId: z.number().int().nullable().openapi({ description: "Videos: the sports profile they belong to." }),
  width: z.number().int().nullable().openapi({ description: "Photos: pixel size of the original, to reserve the space before it loads." }),
  height: z.number().int().nullable(),
});
const PlayerProfile = PlayerCard.extend({
  bio: z.string().nullable(),
  coverUrl: z.string().nullable().openapi({ description: "Wide banner behind the avatar (about 3:1)." }),
  coverWidth: z.number().int().nullable(),
  coverHeight: z.number().int().nullable(),
  media: z.array(MediaItem),
  memberSince: z.string().datetime(),
}).openapi("PlayerProfile");
const MyProfile = PlayerProfile.extend({ isVisible: z.boolean(), hiddenByAdmin: z.boolean(), contactVisibility: z.enum(["ON_TAP", "AFTER_ACCEPT"]) }).openapi("MyPlayerProfile");
const binary = z.string().openapi({ type: "string", format: "binary" });

const T = "Players";
registerRoute({ method: "get", path: "/players/me", tag: T, summary: "My player profile", auth: true, response: MyProfile, errors: [404] });
registerRoute({ method: "post", path: "/players/me", tag: T, summary: "Create my player profile", auth: true, body: createProfileBody, response: MyProfile, status: 201, errors: [409, 422] });
registerRoute({ method: "patch", path: "/players/me", tag: T, summary: "Update my player profile", description: "`isVisible:false` hides me from search and public view. An admin-hidden profile stays hidden.", auth: true, body: updateProfileBody, response: MyProfile, errors: [404, 422] });
registerRoute({ method: "post", path: "/players/me/sports", tag: T, summary: "Add a sport", description: "`positions` must be codes from GET /sports for that sport. Rates are only allowed with `khepAvailable: true`.", auth: true, body: addSportBody, response: MyProfile, status: 201, errors: [404, 409, 422] });
registerRoute({ method: "patch", path: "/players/me/sports/{sportId}", tag: T, summary: "Update a sport", description: "Turning `khepAvailable` off also clears the rates.", auth: true, params: sportParams, body: updateSportBody, response: MyProfile, errors: [404, 422] });
registerRoute({ method: "delete", path: "/players/me/sports/{sportId}", tag: T, summary: "Remove a sport", auth: true, params: sportParams, response: MyProfile, errors: [404] });
registerRoute({ method: "post", path: "/players/me/sports/{sportId}/achievements", tag: T, summary: "Add an achievement to a sport profile", description: `Up to ${MAX_ACHIEVEMENTS} per sport profile.`, auth: true, params: sportParams, body: addAchievementBody, response: MyProfile, status: 201, errors: [404, 409, 422] });
registerRoute({ method: "delete", path: "/players/me/sports/{sportId}/achievements/{achievementId}", tag: T, summary: "Remove an achievement", auth: true, params: achievementParams, response: MyProfile, errors: [404] });
registerRoute({ method: "post", path: "/players/me/media/photos", tag: T, summary: "Add a photo", description: `multipart/form-data, field \`file\`. Up to ${MAX_PHOTOS} photos.`, auth: true, multipart: z.object({ file: binary }), response: MyProfile, status: 201, errors: [404, 409, 413, 415, 422, 502, 503] });
registerRoute({ method: "post", path: "/players/me/media/videos", tag: T, summary: "Add a YouTube video to a sports profile", description: `Up to ${MAX_VIDEOS} per sports profile. YouTube links only; the id is stored and thumbnails are built from it.`, auth: true, body: addVideoBody, response: MyProfile, status: 201, errors: [400, 404, 409, 422] });
registerRoute({ method: "patch", path: "/players/me/media/{mediaId}", tag: T, summary: "Set or clear a caption", auth: true, params: mediaParams, body: updateMediaBody, response: MyProfile, errors: [404, 422] });
registerRoute({ method: "put", path: "/players/me/media/cover", tag: T, summary: "Set my cover photo", description: "multipart/form-data, field `file`. Crop to about 3:1 before upload. The previous cover is deleted.", auth: true, multipart: z.object({ file: binary }), response: MyProfile, errors: [404, 413, 415, 422, 502, 503] });
registerRoute({ method: "delete", path: "/players/me/media/cover", tag: T, summary: "Remove my cover photo", auth: true, response: MyProfile, errors: [404] });
registerRoute({ method: "put", path: "/players/me/media/order", tag: T, summary: "Reorder my gallery photos", description: "`ids` must list every gallery photo exactly once. Videos are ordered by when they were added.", auth: true, body: reorderBody, response: MyProfile, errors: [404, 422] });
registerRoute({ method: "delete", path: "/players/me/media/{mediaId}", tag: T, summary: "Remove a photo or video link", auth: true, params: mediaParams, response: MyProfile, errors: [404] });
registerRoute({
  method: "get",
  path: "/players",
  tag: T,
  summary: "Search players",
  description:
    "Cursor-paginated. Sport-level filters (position, khepAvailable, rate*, availabilityDay) are matched against the same sport entry. " +
    "Hidden, suspended and deleted players — and you — are never returned. `meta.nextCursor` is null on the last page.",
  auth: true,
  query: searchQuery as unknown as z.ZodObject,
  response: z.array(PlayerCard),
  errors: [422],
});
registerRoute({ method: "get", path: "/players/{id}", tag: T, summary: "A player's public profile", auth: true, params: profileParams, response: PlayerProfile, errors: [404] });

// ───────── availability ("আজ খেলবি") ─────────
export const availabilityBody = z.object({
  sportIds: z.array(z.number().int().positive()).min(1).max(10),
  from: z.string().regex(/^\d{2}:\d{2}$/).optional().openapi({ description: "Today's start, Dhaka time HH:MM. Defaults to now." }),
  until: z.string().regex(/^\d{2}:\d{2}$/).optional().openapi({ description: "Today's end, Dhaka time HH:MM. Defaults to midnight." }),
});
const AvailabilityList = z.object({ items: z.array(z.object({ sportId: z.number().int(), startsAt: z.string().datetime(), endsAt: z.string().datetime() })) }).openapi("MyAvailability");
registerRoute({ method: "get", path: "/players/me/availability", tag: T, summary: "Am I available to play today?", auth: true, response: AvailabilityList, errors: [404] });
registerRoute({ method: "put", path: "/players/me/availability", tag: T, summary: "Mark myself available today (per sport, optional window)", description: "Replaces the previous set. Expires at the window end, or midnight Asia/Dhaka.", auth: true, body: availabilityBody, response: AvailabilityList, errors: [400, 404, 422] });
registerRoute({ method: "delete", path: "/players/me/availability", tag: T, summary: "I'm not available any more", auth: true, response: AvailabilityList, errors: [404] });
