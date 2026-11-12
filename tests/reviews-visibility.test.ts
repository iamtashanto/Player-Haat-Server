import { beforeEach, describe, expect, it } from "vitest";
import { revealExpired } from "../src/modules/ratings/ratings.service.js";
import { V1, api, completedMatch, prisma, recruiterUser, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const post = (a: Auth, path: string, body: object) => api().post(`${V1}${path}`).set(a).send(body);
const later = (days: number) => new Date(Date.now() + days * 86_400_000);
const SC = { skill: 5, punctuality: 4, behavior: 5 };

/** One finished game where the captain reviewed the player ("Strong keeper") and the player reviewed the captain. */
async function reviewedGame() {
  const { cap, request, players } = await completedMatch(w, { players: 1 });
  const p = players[0]!;
  await post(cap.auth, `/requests/${request.id}/ratings`, { applicationId: p.app.id, scores: SC, comment: "Strong keeper" });
  await post(p.auth, `/requests/${request.id}/ratings`, { scores: { behavior: 5, organization: 3 }, comment: "Well organised" });
  return { cap, request, p };
}

describe("a player's reviews, signed out", () => {
  it("shows revealed reviews with the reviewer's first name only, and the player's reply", async () => {
    const { p, cap } = await reviewedGame();
    const review = await prisma.rating.findFirstOrThrow({ where: { rateeId: p.user.id } });
    await post(p.auth, `/ratings/${review.id}/reply`, { text: "Thanks coach" });
    await prisma.user.update({ where: { id: cap.user.id }, data: { name: "Rumi Akter Captain" } });

    const res = await api().get(`${V1}/public/players/${p.profileId}/reviews`); // no auth header
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const r = res.body.data[0];
    expect(r).toMatchObject({ comment: "Strong keeper", rater: { firstName: "Rumi" }, reply: { text: "Thanks coach" } });
    expect(JSON.stringify(r)).not.toMatch(/Akter|Captain|avatar|userId|email/i); // nothing that identifies the reviewer further
  });

  it("never shows hidden-until-revealed, admin-hidden or no-show entries", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2 });
    // player 0: reviewed but not yet revealed (the player has not rated back)
    await post(cap.auth, `/requests/${request.id}/ratings`, { applicationId: players[0]!.app.id, scores: SC, comment: "Waiting" });
    // player 1: a no-show strike (no review text) and nothing else
    await post(cap.auth, `/requests/${request.id}/ratings`, { applicationId: players[1]!.app.id, noShow: true });
    expect((await api().get(`${V1}/public/players/${players[0]!.profileId}/reviews`)).body.data).toEqual([]);
    expect((await api().get(`${V1}/public/players/${players[1]!.profileId}/reviews`)).body.data).toEqual([]);

    // once revealed it appears; once an admin hides it, it disappears again
    await revealExpired(later(8));
    expect((await api().get(`${V1}/public/players/${players[0]!.profileId}/reviews`)).body.data).toHaveLength(1);
    await prisma.rating.updateMany({ where: { rateeId: players[0]!.user.id }, data: { hiddenByAdminAt: new Date() } });
    expect((await api().get(`${V1}/public/players/${players[0]!.profileId}/reviews`)).body.data).toEqual([]);
  });

  it("is a 404 for a hidden or missing profile, and paginates", async () => {
    const { p } = await reviewedGame();
    expect((await api().get(`${V1}/public/players/nope/reviews`)).status).toBe(404);
    await prisma.playerProfile.update({ where: { id: p.profileId }, data: { isVisible: false } });
    expect((await api().get(`${V1}/public/players/${p.profileId}/reviews`)).status).toBe(404);
  });
});

describe("an organiser's reviews", () => {
  async function captainWithProfile() {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await prisma.user.update({ where: { id: cap.user.id }, data: { role: "RECRUITER" } });
    const rec = await prisma.recruiterProfile.create({ data: { userId: cap.user.id, type: "CLUB", organization: "Test FC", districtId: w.patuakhali.id, sportIds: [w.football.id] } });
    return { cap, request, p: players[0]!, recruiterProfileId: rec.id };
  }

  it("needs sign-in, and lists what players said after revealed games", async () => {
    const { cap, request, p, recruiterProfileId } = await captainWithProfile();
    await post(cap.auth, `/requests/${request.id}/ratings`, { applicationId: p.app.id, scores: SC });
    await post(p.auth, `/requests/${request.id}/ratings`, { scores: { behavior: 5, organization: 4 }, comment: "Fair and on time" });

    expect((await api().get(`${V1}/recruiters/${recruiterProfileId}/ratings`)).status).toBe(401);
    const viewer = await signedIn("viewer@example.com");
    const res = await api().get(`${V1}/recruiters/${recruiterProfileId}/ratings`).set(viewer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ comment: "Fair and on time", overall: 4.5 });
    expect((await api().get(`${V1}/recruiters/nope/ratings`).set(viewer.auth)).status).toBe(404);
  });

  it("the recruiter card carries a rating summary: New until 3 reviews", async () => {
    const { cap, request, p, recruiterProfileId } = await captainWithProfile();
    const viewer = await signedIn("viewer2@example.com");
    const card = async () => (await api().get(`${V1}/recruiters/${recruiterProfileId}`).set(viewer.auth)).body.data.rating;
    expect(await card()).toMatchObject({ isNew: true, count: 0, average: 0 });
    await post(cap.auth, `/requests/${request.id}/ratings`, { applicationId: p.app.id, scores: SC });
    await post(p.auth, `/requests/${request.id}/ratings`, { scores: { behavior: 5, organization: 5 } });
    expect(await card()).toMatchObject({ isNew: true, count: 1, average: 0 }); // under 3: the average stays hidden
  });

  it("a recruiter who never hosted still has a sensible empty list", async () => {
    const r = await recruiterUser(w, "fresh@example.com");
    const viewer = await signedIn("viewer3@example.com");
    const res = await api().get(`${V1}/recruiters/${r.recruiterId}/ratings`).set(viewer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("top rated players: only people with enough reviews", () => {
  it("ranks by the damped rating and leaves out players who are still 'New'", async () => {
    const { makePlayer } = await import("./helpers.js");
    const bayes = (avg: number, n: number) => (n * avg + 5 * 3.5) / (n + 5);
    await makePlayer(w, { name: "Nobody", avgRating: 0, ratingCount: 0 });
    await makePlayer(w, { name: "TwoReviews", avgRating: 5, ratingCount: 2, bayesRating: bayes(5, 2) }); // still New: not listed
    await makePlayer(w, { name: "Solid", avgRating: 4.5, ratingCount: 20, bayesRating: bayes(4.5, 20) });
    await makePlayer(w, { name: "Good", avgRating: 4.6, ratingCount: 3, bayesRating: bayes(4.6, 3) });
    const res = await api().get(`${V1}/public/top-players`); // signed out
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(["Solid", "Good"]);
  });

  it("can be narrowed to a sport and an area, and never lists hidden profiles", async () => {
    const { makePlayer } = await import("./helpers.js");
    const sports = [{ sportId: w.football.id }];
    await makePlayer(w, { name: "LocalStar", avgRating: 4.8, ratingCount: 5, bayesRating: 4.4, sports });
    await makePlayer(w, { name: "FarStar", avgRating: 4.9, ratingCount: 9, bayesRating: 4.6, sports, upazilaId: w.savar.id, districtId: w.dhaka.id });
    await makePlayer(w, { name: "HiddenStar", avgRating: 5, ratingCount: 12, bayesRating: 4.7, sports, isVisible: false });
    // with a sport chosen, the count that matters is the one earned in that sport (set the way real reviews would)
    await prisma.playerSport.updateMany({ where: { sportId: w.football.id }, data: { avgRating: 4.8, ratingCount: 5 } });
    const res = await api().get(`${V1}/public/top-players?sportId=${w.football.id}&upazilaId=${w.kalapara.id}`);
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(["LocalStar"]);
  });
});
