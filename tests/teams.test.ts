import { beforeEach, describe, expect, it } from "vitest";
import { JPEG } from "./images.js";
import { V1, api, notificationsOf, playerUser, prisma, recruiterUser, requestBody, resetDb, seedWorld, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "patch" | "delete", path: string, a: Auth, body?: object) => {
  const t = api()[method](`${V1}${path}`).set(a);
  return body === undefined ? t : t.send(body);
};
const teamBody = (over: object = {}) => ({ name: "Kalapara XI", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, ...over });
const mk = async (a: Auth, over: object = {}) => (await call("post", "/teams", a, teamBody(over))).body.data as { id: string; joinCode: string };

describe("creating a team", () => {
  it("makes me captain and a member, and shows the join code to me alone", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const res = await call("post", "/teams", cap.auth, teamBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Kalapara XI", isCaptain: true, isMember: true, memberCount: 1, sport: { code: "FOOTBALL" }, location: { upazila: { nameEn: "Kalapara" } } });
    expect(res.body.data.joinCode).toMatch(/^[A-Z0-9]{8}$/);
    const other = await playerUser(w, "other@example.com");
    const seen = (await call("get", `/teams/${res.body.data.id}`, other.auth)).body.data;
    expect(seen).toMatchObject({ isCaptain: false, isMember: false, memberCount: 1 });
    expect(seen.joinCode).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(res.body.data.joinCode);
  });

  it("validates sport, place and name, and caps teams per captain", async () => {
    const cap = await playerUser(w, "cap@example.com");
    expect((await call("post", "/teams", cap.auth, teamBody({ sportId: w.badminton.id }))).status).toBe(422);
    expect((await call("post", "/teams", cap.auth, teamBody({ upazilaId: w.savar.id }))).status).toBe(422); // Savar isn't in Patuakhali
    expect((await call("post", "/teams", cap.auth, teamBody({ name: "x" }))).status).toBe(422);
    expect((await call("post", "/teams", cap.auth, { ...teamBody(), captainId: "someone" })).status).toBe(422);
    for (let i = 0; i < 5; i++) expect((await call("post", "/teams", cap.auth, teamBody({ name: `Team ${i}` }))).status).toBe(201);
    const sixth = await call("post", "/teams", cap.auth, teamBody({ name: "Team 6" }));
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe("TEAM_LIMIT");
  });

  it("recruiters can run a team too (a club)", async () => {
    const rec = await recruiterUser(w);
    expect((await call("post", "/teams", rec.auth, teamBody({ name: "Barishal United U-17" }))).status).toBe(201);
  });
});

describe("joining with the code", () => {
  it("a player joins by code, the captain is told, and the team lists them", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const p = await playerUser(w, "p@example.com");
    await prisma.user.update({ where: { id: p.user.id }, data: { name: "Imran Hossain" } });
    const team = await mk(cap.auth);
    const res = await call("post", "/teams/join", p.auth, { code: team.joinCode.toLowerCase() }); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isMember: true, isCaptain: false, memberCount: 2 });
    expect(res.body.data.members.map((m: { name: string; role: string }) => m.role)).toEqual(["CAPTAIN", "PLAYER"]);
    expect(res.body.data.joinCode).toBeUndefined();
    const [joined] = await notificationsOf(cap.user.id, "TEAM_JOINED");
    expect(String((joined!.data as { actor: string }).actor)).toContain("Imran Hossain");
    expect((await call("get", "/teams/mine", p.auth)).body.data.map((t: { id: string }) => t.id)).toEqual([team.id]);
  });

  it("rejects bad, unknown and repeated codes, and recruiters can't join (members are players)", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const p = await playerUser(w, "p@example.com");
    const team = await mk(cap.auth);
    expect((await call("post", "/teams/join", p.auth, { code: "nope" })).status).toBe(422);
    expect((await call("post", "/teams/join", p.auth, { code: "ZZZZZZZZ" })).status).toBe(404);
    expect((await call("post", "/teams/join", cap.auth, { code: team.joinCode })).body.error.code).toBe("TEAM_ALREADY_MEMBER");
    await call("post", "/teams/join", p.auth, { code: team.joinCode });
    expect((await call("post", "/teams/join", p.auth, { code: team.joinCode })).status).toBe(409);
    const rec = await recruiterUser(w);
    expect((await call("post", "/teams/join", rec.auth, { code: team.joinCode })).status).toBe(403);
    expect(await prisma.teamMember.count({ where: { teamId: team.id } })).toBe(2);
  });

  it("a team stops at 40 members", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const team = await mk(cap.auth);
    const users = [];
    for (let i = 0; i < 39; i++) users.push((await playerUser(w, `m${i}@example.com`)).user.id);
    await prisma.teamMember.createMany({ data: users.map((userId) => ({ teamId: team.id, userId })) });
    const late = await playerUser(w, "late@example.com");
    const res = await call("post", "/teams/join", late.auth, { code: team.joinCode });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TEAM_FULL");
  });

  it("a new code replaces the old one at once, and keeps current members", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const a = await playerUser(w, "a@example.com");
    const b = await playerUser(w, "b@example.com");
    const team = await mk(cap.auth);
    await call("post", "/teams/join", a.auth, { code: team.joinCode });
    const fresh = (await call("post", `/teams/${team.id}/join-code`, cap.auth)).body.data.joinCode;
    expect(fresh).not.toBe(team.joinCode);
    expect((await call("post", "/teams/join", b.auth, { code: team.joinCode })).status).toBe(404);
    expect((await call("post", "/teams/join", b.auth, { code: fresh })).status).toBe(200);
    expect((await call("get", `/teams/${team.id}`, a.auth)).body.data.memberCount).toBe(3);
    expect((await call("post", `/teams/${team.id}/join-code`, a.auth)).status).toBe(403);
  });
});

describe("running the team", () => {
  it("only the captain edits, removes members or deletes; the captain can't leave their own team", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const p = await playerUser(w, "p@example.com");
    const team = await mk(cap.auth);
    const joined = (await call("post", "/teams/join", p.auth, { code: team.joinCode })).body.data;
    const memberId = joined.members.find((m: { role: string }) => m.role === "PLAYER").memberId;

    expect((await call("patch", `/teams/${team.id}`, p.auth, { name: "Hijacked" })).status).toBe(403);
    expect((await call("delete", `/teams/${team.id}/members/${memberId}`, p.auth)).status).toBe(403);
    expect((await call("delete", `/teams/${team.id}`, p.auth)).status).toBe(403);
    expect((await call("patch", `/teams/${team.id}`, cap.auth, { name: "Kalapara FC" })).body.data.name).toBe("Kalapara FC");
    expect((await call("patch", `/teams/${team.id}`, cap.auth, {})).status).toBe(422);
    expect((await call("patch", `/teams/${team.id}`, cap.auth, { districtId: w.patuakhali.id })).status).toBe(422); // place fields move together

    const capMember = joined.members.find((m: { role: string }) => m.role === "CAPTAIN").memberId;
    expect((await call("delete", `/teams/${team.id}/members/${capMember}`, cap.auth)).body.error.code).toBe("TEAM_CAPTAIN_CANNOT_LEAVE");
    expect((await call("post", `/teams/${team.id}/leave`, cap.auth)).body.error.code).toBe("TEAM_CAPTAIN_CANNOT_LEAVE");
    expect((await call("delete", `/teams/${team.id}/members/${memberId}`, cap.auth)).body.data.memberCount).toBe(1);
    expect((await call("get", "/teams/mine", p.auth)).body.data).toEqual([]);
  });

  it("members can leave; deleting a team keeps the requests posted for it", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const p = await playerUser(w, "p@example.com");
    const team = await mk(cap.auth);
    await call("post", "/teams/join", p.auth, { code: team.joinCode });
    expect((await call("post", `/teams/${team.id}/leave`, p.auth)).body.data.left).toBe(true);
    expect((await call("post", `/teams/${team.id}/leave`, p.auth)).status).toBe(404);

    const req = await call("post", "/requests", cap.auth, requestBody(w, { teamId: team.id }));
    expect(req.status).toBe(201);
    expect(req.body.data.team).toMatchObject({ id: team.id, name: "Kalapara XI" }); // the existing request ↔ team link
    expect((await call("post", "/requests", p.auth, requestBody(w, { teamId: team.id }))).status).toBe(422); // not their team
    expect((await call("delete", `/teams/${team.id}`, cap.auth)).body.data.deleted).toBe(true);
    expect((await call("get", `/teams/${team.id}`, cap.auth)).status).toBe(404);
    expect((await call("get", `/requests/${req.body.data.id}`, cap.auth)).body.data.team).toBeNull();
  });

  it("a logo must be one of my own team-logo uploads", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const other = await playerUser(w, "other@example.com");
    const team = await mk(cap.auth);
    const up = async (a: Auth, type: string) => (await api().post(`${V1}/media/images`).set(a).field("type", type).attach("file", JPEG, { filename: "l.jpg", contentType: "image/jpeg" })).body.data.publicId as string;
    const theirs = await up(other.auth, "team-logo");
    const wrongKind = await up(cap.auth, "avatar");
    expect((await call("patch", `/teams/${team.id}`, cap.auth, { logoPublicId: theirs })).status).toBe(422);
    expect((await call("patch", `/teams/${team.id}`, cap.auth, { logoPublicId: wrongKind })).status).toBe(422);
    const mine = await up(cap.auth, "team-logo");
    const set = await call("patch", `/teams/${team.id}`, cap.auth, { logoPublicId: mine });
    expect(set.body.data.logoUrl).toContain(mine);
    expect((await call("patch", `/teams/${team.id}`, cap.auth, { logoPublicId: null })).body.data.logoUrl).toBeNull();
  });

  it("is closed to anonymous callers and to admins", async () => {
    const cap = await playerUser(w, "cap@example.com");
    const team = await mk(cap.auth);
    expect((await api().get(`${V1}/teams/${team.id}`)).status).toBe(401);
    expect((await api().post(`${V1}/teams/join`).send({ code: team.joinCode })).status).toBe(401);
  });
});
