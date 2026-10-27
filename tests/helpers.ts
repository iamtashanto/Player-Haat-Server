import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { clearConfigCache } from "../src/modules/app-config/app-config.service.js";
import { flushBackground } from "../src/modules/notifications/notifier.js";
import { fakeSms } from "./fake-sms.js";
import { fakePush } from "./fake-push.js";
import { fakeStorage } from "./fake-storage.js";
import { mailbox } from "./mailbox.js";

export const prisma = new PrismaClient();
export const app = createApp();
export const api = () => request(app);
export const V1 = "/api/v1";

export const bearer = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

export const DEFAULT_USER = { name: "Rakib Hasan", email: "rakib@example.com", password: "Passw0rd1" };

/** Wipes all data (including seeded reference rows — tests create what they need). */
export async function resetDb() {
  await flushBackground(); // stray notifications from the previous test must not land in the next one
  mailbox.length = 0;
  fakeStorage.reset();
  fakePush.reset();
  fakeSms.reset();
  clearConfigCache();
  await prisma.$executeRawUnsafe(
    `TRUNCATE "User","Division","Sport","AppConfig","VerificationCode","CreditPack" RESTART IDENTITY CASCADE`,
  );
  // The migration seeds the starter credit packs; restore them so every test begins from the same catalogue.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditPack" ("id","code","credits","priceBdt","isActive","order") VALUES ('pack_starter','STARTER',10,99,true,1),('pack_plus','PLUS',30,249,true,2),('pack_pro','PRO',100,699,true,3)`,
  );
}

export async function registerUser(overrides: Partial<typeof DEFAULT_USER> & { deviceId?: string } = {}) {
  const body = { ...DEFAULT_USER, ...overrides };
  const res = await api().post(`${V1}/auth/register`).send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    body,
    user: res.body.data.user as { id: string; email: string },
    accessToken: res.body.data.tokens.accessToken as string,
    refreshToken: res.body.data.tokens.refreshToken as string,
  };
}

export async function login(email = DEFAULT_USER.email, password = DEFAULT_USER.password, deviceId?: string) {
  return api().post(`${V1}/auth/login`).send({ email, password, deviceId });
}

// ───────────────────────── Phase 3 fixtures ─────────────────────────

/** A tiny Bangladesh: two districts, three upazilas, a few unions, football + cricket. */
export async function seedWorld() {
  const division = await prisma.division.create({ data: { slug: "barishal", nameEn: "Barishal", nameBn: "বরিশাল" } });
  const dhakaDiv = await prisma.division.create({ data: { slug: "dhaka", nameEn: "Dhaka", nameBn: "ঢাকা" } });
  const patuakhali = await prisma.district.create({ data: { divisionId: division.id, slug: "patuakhali", nameEn: "Patuakhali", nameBn: "পটুয়াখালী" } });
  const dhaka = await prisma.district.create({ data: { divisionId: dhakaDiv.id, slug: "dhaka", nameEn: "Dhaka", nameBn: "ঢাকা" } });
  const kalapara = await prisma.upazila.create({ data: { districtId: patuakhali.id, slug: "kalapara", nameEn: "Kalapara", nameBn: "কলাপাড়া" } });
  const galachipa = await prisma.upazila.create({ data: { districtId: patuakhali.id, slug: "galachipa", nameEn: "Galachipa", nameBn: "গলাচিপা" } });
  const savar = await prisma.upazila.create({ data: { districtId: dhaka.id, slug: "savar", nameEn: "Savar", nameBn: "সাভার" } });
  const latachapli = await prisma.union.create({ data: { upazilaId: kalapara.id, slug: "latachapli", nameEn: "Latachapli", nameBn: "লতাচাপলী" } });
  const mohipur = await prisma.union.create({ data: { upazilaId: kalapara.id, slug: "mohipur", nameEn: "Mohipur", nameBn: "মহিপুর" } });
  const football = await prisma.sport.create({
    data: {
      code: "FOOTBALL",
      nameEn: "Football",
      nameBn: "ফুটবল",
      positions: { create: ["GK", "CB", "CM", "ST"].map((code, order) => ({ code, nameEn: code, nameBn: code, order })) },
    },
  });
  const cricket = await prisma.sport.create({
    data: {
      code: "CRICKET",
      nameEn: "Cricket",
      nameBn: "ক্রিকেট",
      positions: { create: ["BATTER", "BOWLER"].map((code, order) => ({ code, nameEn: code, nameBn: code, order })) },
    },
  });
  const badminton = await prisma.sport.create({ data: { code: "BADMINTON", nameEn: "Badminton", nameBn: "ব্যাডমিন্টন", isActive: false } });
  return { patuakhali, dhaka, kalapara, galachipa, savar, latachapli, mohipur, football, cricket, badminton };
}
export type World = Awaited<ReturnType<typeof seedWorld>>;

export interface SportSpec {
  sportId: number;
  positions?: string[];
  skillLevel?: number;
  khepAvailable?: boolean;
  rateMin?: number | null;
  rateMax?: number | null;
  availability?: Record<string, string[]>;
  travelRadius?: "UNION" | "UPAZILA" | "DISTRICT";
}

/** Creates a user + visible profile directly in the DB (fast). Returns a token if `withToken`. */
export async function makePlayer(
  w: World,
  o: {
    name?: string;
    email?: string;
    upazilaId?: number;
    districtId?: number;
    unionId?: number | null;
    avgRating?: number;
    ratingCount?: number;
    lastActiveAt?: Date;
    isVisible?: boolean;
    hiddenByAdminAt?: Date | null;
    status?: "ACTIVE" | "SUSPENDED" | "DELETED";
    sports?: SportSpec[];
  } = {},
) {
  const n = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({
    data: { name: o.name ?? `Player ${n}`, email: o.email ?? `p-${n}@example.com`, status: o.status ?? "ACTIVE" },
  });
  const profile = await prisma.playerProfile.create({
    data: {
      userId: user.id,
      districtId: o.districtId ?? w.patuakhali.id,
      upazilaId: o.upazilaId ?? w.kalapara.id,
      unionId: o.unionId ?? null,
      avgRating: o.avgRating ?? 0,
      ratingCount: o.ratingCount ?? 0,
      lastActiveAt: o.lastActiveAt ?? new Date(),
      isVisible: o.isVisible ?? true,
      hiddenByAdminAt: o.hiddenByAdminAt ?? null,
      sports: {
        create: (o.sports ?? []).map((s) => ({
          sportId: s.sportId,
          positions: s.positions ?? [],
          skillLevel: s.skillLevel ?? 3,
          khepAvailable: s.khepAvailable ?? false,
          rateMin: s.rateMin ?? null,
          rateMax: s.rateMax ?? null,
          availability: s.availability ?? undefined,
          travelRadius: s.travelRadius ?? "UPAZILA",
        })),
      },
    },
  });
  return { userId: user.id, profileId: profile.id };
}

/** A registered, logged-in user with a ready-to-use bearer header. */
export async function signedIn(email = "viewer@example.com") {
  const u = await registerUser({ email, name: "Viewer" });
  return { ...u, auth: bearer(u.accessToken) };
}

// ───────────────────────── Phase 4 fixtures ─────────────────────────

/** Waits for fire-and-forget work (notifications) triggered by the last request. */
export const settle = flushBackground;
export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

/** A registered user who also has a player profile (Kalapara) with the given sports. Returns auth + ids. */
export async function playerUser(w: World, email: string, sports: SportSpec[] = [], extra: Parameters<typeof makePlayerProfileFor>[2] = {}) {
  const s = await signedIn(email);
  const profile = await makePlayerProfileFor(w, s.user.id, extra, sports);
  return { ...s, profileId: profile.id };
}

async function makePlayerProfileFor(
  w: World,
  userId: string,
  o: { upazilaId?: number; districtId?: number; unionId?: number | null; avgRating?: number; isVisible?: boolean } = {},
  sports: SportSpec[] = [],
) {
  return prisma.playerProfile.create({
    data: {
      userId,
      districtId: o.districtId ?? w.patuakhali.id,
      upazilaId: o.upazilaId ?? w.kalapara.id,
      unionId: o.unionId ?? null,
      avgRating: o.avgRating ?? 0,
      isVisible: o.isVisible ?? true,
      sports: {
        create: sports.map((s) => ({
          sportId: s.sportId,
          positions: s.positions ?? [],
          skillLevel: s.skillLevel ?? 3,
          khepAvailable: s.khepAvailable ?? false,
          rateMin: s.rateMin ?? null,
          rateMax: s.rateMax ?? null,
          travelRadius: s.travelRadius ?? "UPAZILA",
          availability: s.availability ?? undefined,
        })),
      },
    },
  });
}

/** Inserts a request straight into the DB (any status/time), bypassing API validation. */
export async function makeRequest(
  w: World,
  createdById: string,
  o: Partial<{
    sportId: number;
    matchAt: Date;
    status: "OPEN" | "FILLED" | "CANCELLED" | "COMPLETED";
    playersNeeded: number;
    playersAccepted: number;
    positionsNeeded: string[];
    isPaid: boolean;
    budgetMin: number | null;
    budgetMax: number | null;
    isHidden: boolean;
    upazilaId: number;
    districtId: number;
    unionId: number | null;
    venueText: string;
  }> = {},
) {
  return prisma.playerRequest.create({
    data: {
      createdById,
      sportId: o.sportId ?? w.football.id,
      matchAt: o.matchAt ?? hoursFromNow(48),
      venueText: o.venueText ?? "Kuakata Ground",
      districtId: o.districtId ?? w.patuakhali.id,
      upazilaId: o.upazilaId ?? w.kalapara.id,
      unionId: o.unionId ?? null,
      positionsNeeded: o.positionsNeeded ?? [],
      playersNeeded: o.playersNeeded ?? 2,
      playersAccepted: o.playersAccepted ?? 0,
      status: o.status ?? "OPEN",
      isPaid: o.isPaid ?? false,
      budgetMin: o.budgetMin ?? null,
      budgetMax: o.budgetMax ?? null,
      isHidden: o.isHidden ?? false,
    },
  });
}

/** Inserts an application straight into the DB. */
export const makeApplication = (requestId: string, playerId: string, status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" = "PENDING") =>
  prisma.application.create({ data: { requestId, playerId, status, respondedAt: status === "PENDING" ? null : new Date() } });

export const requestBody = (w: World, over: Record<string, unknown> = {}) => ({
  sportId: w.football.id,
  matchAt: hoursFromNow(48).toISOString(),
  venueText: "Kuakata Sea Beach Ground",
  districtId: w.patuakhali.id,
  upazilaId: w.kalapara.id,
  positionsNeeded: ["GK"],
  playersNeeded: 2,
  ...over,
});

// ───────────────────────── Phase 5 fixtures ─────────────────────────

/** A signed-in user promoted to ADMIN (the role is read from the DB on every request). */
export async function adminUser(email = "admin@example.com") {
  const s = await signedIn(email);
  await prisma.user.update({ where: { id: s.user.id }, data: { role: "ADMIN" } });
  return s;
}

/**
 * A finished match: a captain, `players` accepted players (each with a profile + football), and a
 * COMPLETED request whose rating window opened `completedHoursAgo` hours ago.
 */
export async function completedMatch(w: World, o: { players?: number; completedHoursAgo?: number; isPaid?: boolean; captainEmail?: string } = {}) {
  const cap = await signedIn(o.captainEmail ?? "cap@example.com");
  const n = o.players ?? 2;
  const request = await makeRequest(w, cap.user.id, {
    status: "COMPLETED",
    isPaid: o.isPaid ?? false,
    matchAt: hoursFromNow(-(o.completedHoursAgo ?? 5) - 3),
    playersNeeded: n,
    playersAccepted: n,
  });
  await prisma.playerRequest.update({ where: { id: request.id }, data: { completedAt: hoursFromNow(-(o.completedHoursAgo ?? 5)) } });
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = await playerUser(w, `player${i}@example.com`, [{ sportId: w.football.id, positions: ["GK"] }]);
    const app = await makeApplication(request.id, p.user.id, "ACCEPTED");
    players.push({ ...p, app });
  }
  return { cap, request, players };
}

// ───────────────────────── Roles & recruiters ─────────────────────────

/** Registers through the public API with an explicit account type. */
export async function registerAs(role: "PLAYER" | "RECRUITER", email: string) {
  const u = await registerUser({ email, name: `${role} ${email.split("@")[0]}`, ...({ role } as object) });
  return { ...u, auth: bearer(u.accessToken) };
}

/** A recruiter who has finished onboarding (profile created directly in the DB). */
export async function recruiterUser(w: World, email = "recruiter@example.com", o: { onboard?: boolean; organization?: string } = {}) {
  const s = await registerAs("RECRUITER", email);
  const profile =
    o.onboard === false
      ? null
      : await prisma.recruiterProfile.create({
          data: { userId: s.user.id, type: "CLUB", organization: o.organization ?? "Barishal United", districtId: w.patuakhali.id, sportIds: [w.football.id] },
        });
  return { ...s, recruiterId: profile?.id ?? null };
}

/** Signs in through the dashboard endpoint (the only way an admin gets a session). */
export const adminLogin = (email = "admin@example.com", password = DEFAULT_USER.password) =>
  api().post(`${V1}/admin/auth/login`).send({ email, password });

// ───────────────────────── Contact, credits, chat ─────────────────────────

/** A published number for a user (users sign up without one). */
export const withPhone = (userId: string, phone = "+8801712345678") => prisma.user.update({ where: { id: userId }, data: { phone } });

/** Gives a user credits through the real ledger. */
export async function giveCredits(userId: string, amount: number) {
  const { grantCredits } = await import("../src/modules/billing/credits.service.js");
  await prisma.$transaction((tx) => grantCredits(tx, userId, amount, "ADMIN_GRANT"));
}

/** Turns pay-per-contact on with explicit prices (the admin does this with /admin/app-config). */
export async function setPricing(over: Partial<Record<"contact_credits_enabled" | "contact_free_per_day" | "contact_credit_cost" | "boost_enabled" | "boost_credit_cost" | "boost_hours", boolean | number>>) {
  const { clearConfigCache } = await import("../src/modules/app-config/app-config.service.js");
  for (const [key, value] of Object.entries(over)) {
    await prisma.appConfig.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
  }
  clearConfigCache();
}

export const notificationsOf = async (userId: string, type?: string) => {
  await settle();
  return prisma.notification.findMany({ where: { userId, ...(type && { type: type as never }) }, orderBy: { createdAt: "asc" } });
};

/** An accepted invite between a recruiter and a player: the strongest "we agreed" relationship. */
export async function acceptedInvite(recruiterUserId: string, profileId: string) {
  return prisma.invite.create({ data: { recruiterId: recruiterUserId, profileId, status: "ACCEPTED", respondedAt: new Date() } });
}
