import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, makeApplication, playerUser, prisma, requestBody, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "patch" | "put", path: string, a: Auth, body?: object) => {
  const t = api()[method](`${V1}${path}`).set(a);
  return body === undefined ? t : t.send(body);
};
const football = () => [{ sportId: w.football.id, positions: ["GK"] }];

async function game(over: Record<string, unknown> = {}, who?: Awaited<ReturnType<typeof signedIn>>) {
  const org = who ?? (await signedIn("org@example.com"));
  const res = await call("post", "/requests", org.auth, requestBody(w, { playersNeeded: 4, groundFee: 1000, feePayTo: "bKash 01712345678", ...over }));
  return { org, res, id: res.body.data?.id as string };
}

describe("ground-fee split", () => {
  it("the share is the fee divided by the players needed, rounded up; only the organiser and accepted players see where to pay", async () => {
    const { org, res, id } = await game({ playersNeeded: 3 });
    expect(res.status).toBe(201);
    expect(res.body.data.fee).toMatchObject({ total: 1000, share: 334, payTo: "bKash 01712345678", paidCount: 0 });

    const stranger = await playerUser(w, "s@example.com", football());
    const seen = (await call("get", `/requests/${id}`, stranger.auth)).body.data.fee;
    expect(seen).toMatchObject({ total: 1000, share: 334, payTo: null });
    expect(JSON.stringify((await call("get", `/requests/${id}`, stranger.auth)).body)).not.toContain("01712345678");

    const pending = await playerUser(w, "pending@example.com", football());
    await makeApplication(id, pending.user.id, "PENDING");
    expect((await call("get", `/requests/${id}`, pending.auth)).body.data.fee.payTo).toBeNull();

    const accepted = await playerUser(w, "acc@example.com", football());
    await makeApplication(id, accepted.user.id, "ACCEPTED");
    expect((await call("get", `/requests/${id}`, accepted.auth)).body.data.fee).toMatchObject({ payTo: "bKash 01712345678", iPaid: false });
    expect((await call("get", `/requests/${id}`, org.auth)).body.data.fee.payTo).toBe("bKash 01712345678");
  });

  it("the organiser ticks and unticks who has paid; the player and the count follow", async () => {
    const { org, id } = await game();
    const p = await playerUser(w, "p@example.com", football());
    const app = await makeApplication(id, p.user.id, "ACCEPTED");
    const ticked = await call("put", `/applications/${app.id}/fee-paid`, org.auth, { paid: true });
    expect(ticked.status).toBe(200);
    expect(ticked.body.data.feePaidAt).not.toBeNull();
    expect((await call("get", `/requests/${id}`, org.auth)).body.data.fee.paidCount).toBe(1);
    expect((await call("get", `/requests/${id}`, p.auth)).body.data.fee.iPaid).toBe(true);
    expect((await call("get", "/applications/mine", p.auth)).body.data[0].request.fee).toMatchObject({ iPaid: true, payTo: "bKash 01712345678" });
    await call("put", `/applications/${app.id}/fee-paid`, org.auth, { paid: false });
    expect((await call("get", `/requests/${id}`, org.auth)).body.data.fee.paidCount).toBe(0);
  });

  it("only the organiser can tick; only accepted players; only when there is a fee", async () => {
    const { org, id } = await game();
    const p = await playerUser(w, "p@example.com", football());
    const pending = await makeApplication(id, p.user.id, "PENDING");
    expect((await call("put", `/applications/${pending.id}/fee-paid`, p.auth, { paid: true })).status).toBe(403);
    expect((await call("put", `/applications/${pending.id}/fee-paid`, org.auth, { paid: true })).body.error.code).toBe("APPLICATION_NOT_ACCEPTED");
    const free = await game({ groundFee: null, feePayTo: null }, org);
    const q = await playerUser(w, "q@example.com", football());
    const acc = await makeApplication(free.id, q.user.id, "ACCEPTED");
    expect((await call("put", `/applications/${acc.id}/fee-paid`, free.org.auth, { paid: true })).body.error.code).toBe("FEE_NOT_SET");
  });

  it("can be set or changed later; clearing the fee clears where to pay; events and a payee without a fee are refused", async () => {
    const { org, id } = await game({ groundFee: null, feePayTo: null });
    expect((await call("get", `/requests/${id}`, org.auth)).body.data.fee).toBeNull();
    const set = await call("patch", `/requests/${id}`, org.auth, { groundFee: 800, feePayTo: "Nagad 01800000000" });
    expect(set.body.data.fee).toMatchObject({ total: 800, share: 200, payTo: "Nagad 01800000000" });
    const cleared = await call("patch", `/requests/${id}`, org.auth, { groundFee: null });
    expect(cleared.body.data.fee).toBeNull();
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id } })).feePayTo).toBeNull();
    expect((await call("patch", `/requests/${id}`, org.auth, { feePayTo: "bKash 01" })).status).toBe(422);
    const bad = await call("post", "/requests", org.auth, requestBody(w, { groundFee: null, feePayTo: "bKash 01712345678" }));
    expect(bad.status).toBe(422);
  });
});
