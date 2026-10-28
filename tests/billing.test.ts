import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, giveCredits, playerUser, prisma, recruiterUser, resetDb, seedWorld, setPricing, signedIn, type World } from "./helpers.js";
import { spendCredits } from "../src/modules/billing/credits.service.js";

type Auth = Record<string, string>;
let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});
const call = (method: "get" | "post" | "put", path: string, a: Auth, body: object = {}, query: object = {}) => api()[method](`${V1}${path}`).set(a).query(query).send(body);
const balanceOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance;
const packId = async (code = "STARTER") => (await prisma.creditPack.findUniqueOrThrow({ where: { code } })).id;

describe("wallet", () => {
  it("shows the balance, prices, active packs and the ways to pay", async () => {
    const p = await playerUser(w, "p@example.com");
    const res = (await call("get", "/billing/wallet", p.auth)).body.data;
    expect(res.balance).toBe(0);
    expect(res.pricing).toMatchObject({ contactCreditsEnabled: false, freeContactsPerDay: 5, boostHours: 48 });
    expect(res.packs.map((x: { code: string }) => x.code)).toEqual(["STARTER", "PLUS", "PRO"]);
    expect(res.methods.map((m: { method: string }) => m.method)).toEqual(["BKASH"]); // only methods with a configured number are offered; payment is manual only
    expect(res.methods[0].payTo).toBe("01700000000");
  });

  it("is open to players and recruiters, closed to anonymous callers", async () => {
    const rec = await recruiterUser(w);
    expect((await call("get", "/billing/wallet", rec.auth)).status).toBe(200);
    expect((await api().get(`${V1}/billing/wallet`)).status).toBe(401);
  });
});

describe("buying credits", () => {
  it("there is no instant payment: a checkout waits for the customer and an admin", async () => {
    const p = await playerUser(w, "p@example.com");
    const res = await call("post", "/billing/checkout", p.auth, { packId: await packId("PLUS"), method: "BKASH" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "PENDING", credits: 30, amountBdt: 249, payTo: "01700000000" });
    expect(await balanceOf(p.user.id)).toBe(0); // nothing is credited until an admin approves
    expect((await call("post", "/billing/checkout", p.auth, { packId: await packId("PLUS"), method: "SANDBOX" })).status).toBe(422); // the old test method is gone
  });

  it("mobile banking: pay, submit the transaction id, an admin approves, credits arrive once", async () => {
    const p = await playerUser(w, "p@example.com");
    const co = await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" });
    expect(co.body.data).toMatchObject({ status: "PENDING", method: "BKASH", payTo: "01700000000", credits: 10, amountBdt: 99 });
    const id = co.body.data.id;

    const submit = await call("post", `/billing/payments/${id}/submit`, p.auth, { trxId: "9g7h2k4lmn", senderNumber: "01712345678" });
    expect(submit.body.data).toMatchObject({ status: "SUBMITTED", trxId: "9G7H2K4LMN", payTo: null });
    expect(await balanceOf(p.user.id)).toBe(0); // nothing yet

    const queue = (await call("get", "/admin/payments", admin.auth)).body.data;
    expect(queue).toEqual([expect.objectContaining({ id, trxId: "9G7H2K4LMN", senderNumber: "+8801712345678", user: expect.objectContaining({ id: p.user.id }) })]);

    expect((await call("post", `/admin/payments/${id}/approve`, admin.auth)).body.data.status).toBe("PAID");
    expect(await balanceOf(p.user.id)).toBe(10);
    expect((await call("post", `/admin/payments/${id}/approve`, admin.auth)).status).toBe(409);
    expect(await balanceOf(p.user.id)).toBe(10); // a second approval can't credit twice
    expect((await prisma.adminAction.findMany({ where: { action: "PAYMENT_APPROVE" } })).length).toBe(1);
  });

  it("two admins approving at the same moment credit the payment once", async () => {
    const p = await playerUser(w, "p@example.com");
    const admin2 = await adminUser("admin2@example.com");
    const id = (await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" })).body.data.id;
    await call("post", `/billing/payments/${id}/submit`, p.auth, { trxId: "RACE123456", senderNumber: "01712345678" });
    const results = await Promise.all([call("post", `/admin/payments/${id}/approve`, admin.auth), call("post", `/admin/payments/${id}/approve`, admin2.auth)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balanceOf(p.user.id)).toBe(10);
  });

  it("a transaction id buys credits once, ever", async () => {
    const a = await playerUser(w, "a@example.com");
    const b = await playerUser(w, "b@example.com");
    const submit = async (u: typeof a) => {
      const id = (await call("post", "/billing/checkout", u.auth, { packId: await packId(), method: "BKASH" })).body.data.id;
      return call("post", `/billing/payments/${id}/submit`, u.auth, { trxId: "SAMETRX123", senderNumber: "01712345678" });
    };
    expect((await submit(a)).status).toBe(200);
    const dup = await submit(b);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("PAYMENT_TRX_USED");
  });

  it("an admin can reject with a reason; the user is told and nothing is credited", async () => {
    const p = await playerUser(w, "p@example.com");
    const id = (await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" })).body.data.id;
    await call("post", `/billing/payments/${id}/submit`, p.auth, { trxId: "FAKE123456", senderNumber: "01712345678" });
    expect((await call("post", `/admin/payments/${id}/reject`, admin.auth, {})).status).toBe(422); // a reason is required
    const res = await call("post", `/admin/payments/${id}/reject`, admin.auth, { note: "No such transaction" });
    expect(res.body.data).toMatchObject({ status: "REJECTED", reviewNote: "No such transaction" });
    expect(await balanceOf(p.user.id)).toBe(0);
    expect((await call("get", "/billing/payments", p.auth)).body.data[0]).toMatchObject({ status: "REJECTED", reviewNote: "No such transaction" });
  });

  it("validates input and ownership", async () => {
    const a = await playerUser(w, "a@example.com");
    const b = await playerUser(w, "b@example.com");
    expect((await call("post", "/billing/checkout", a.auth, { packId: "nope", method: "BKASH" })).status).toBe(404);
    expect((await call("post", "/billing/checkout", a.auth, { packId: await packId(), method: "ROCKET" })).status).toBe(503); // not configured → not offered
    expect((await call("post", "/billing/checkout", a.auth, { packId: await packId(), method: "PAYPAL" })).status).toBe(422);
    const id = (await call("post", "/billing/checkout", a.auth, { packId: await packId(), method: "BKASH" })).body.data.id;
    expect((await call("post", `/billing/payments/${id}/submit`, b.auth, { trxId: "ABCDEF123", senderNumber: "01712345678" })).status).toBe(404); // someone else's payment
    for (const bad of [{ trxId: "x", senderNumber: "01712345678" }, { trxId: "ABC DEF 123", senderNumber: "01712345678" }, { trxId: "ABCDEF123", senderNumber: "123" }]) {
      expect((await call("post", `/billing/payments/${id}/submit`, a.auth, bad)).status).toBe(422);
    }
    expect((await call("get", "/billing/payments", b.auth)).body.data).toEqual([]);
  });

  it("limits unfinished payments, and an inactive pack can't be bought", async () => {
    const p = await playerUser(w, "p@example.com");
    for (let i = 0; i < 3; i++) expect((await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" })).status).toBe(201);
    const fourth = await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("PAYMENT_TOO_MANY_OPEN");
    await call("put", `/admin/credit-packs/${await packId("PRO")}`, admin.auth, { isActive: false });
    expect((await call("post", "/billing/checkout", (await playerUser(w, "q@example.com")).auth, { packId: await packId("PRO"), method: "BKASH" })).status).toBe(404);
  });

  it("editing a pack never rewrites an order already placed", async () => {
    const p = await playerUser(w, "p@example.com");
    const id = (await call("post", "/billing/checkout", p.auth, { packId: await packId(), method: "BKASH" })).body.data.id;
    await call("put", `/admin/credit-packs/${await packId()}`, admin.auth, { credits: 1, priceBdt: 500 });
    await call("post", `/billing/payments/${id}/submit`, p.auth, { trxId: "OLDPRICE12", senderNumber: "01712345678" });
    await call("post", `/admin/payments/${id}/approve`, admin.auth);
    expect(await balanceOf(p.user.id)).toBe(10); // bought at 10 credits / ৳99
  });
});

describe("credits ledger", () => {
  it("never lets a balance go negative, even when two spends race", async () => {
    const p = await playerUser(w, "p@example.com");
    await giveCredits(p.user.id, 1);
    const spend = () => prisma.$transaction((tx) => spendCredits(tx, p.user.id, 1, "BOOST"));
    const results = await Promise.allSettled([spend(), spend(), spend()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.every((r) => (r.reason as { code: string }).code === "CREDITS_REQUIRED")).toBe(true);
    expect(await balanceOf(p.user.id)).toBe(0);
  });

  it("keeps the balance equal to the sum of the ledger", async () => {
    const p = await playerUser(w, "p@example.com");
    await giveCredits(p.user.id, 10);
    await prisma.$transaction((tx) => spendCredits(tx, p.user.id, 3, "CONTACT_REVEAL"));
    const sum = (await prisma.creditTransaction.aggregate({ where: { userId: p.user.id }, _sum: { delta: true } }))._sum.delta;
    expect(sum).toBe(7);
    expect(await balanceOf(p.user.id)).toBe(7);
    await expect(prisma.user.update({ where: { id: p.user.id }, data: { creditBalance: -1 } })).rejects.toThrow(); // CHECK constraint
  });

  it("lists my history newest first", async () => {
    const p = await playerUser(w, "p@example.com");
    await giveCredits(p.user.id, 5);
    await prisma.$transaction((tx) => spendCredits(tx, p.user.id, 2, "BOOST"));
    const rows = (await call("get", "/billing/transactions", p.auth)).body.data;
    expect(rows.map((r: { delta: number }) => r.delta)).toEqual([-2, 5]);
  });
});

describe("admin: credits and packs", () => {
  it("grants and takes back credits with an audit trail; a refund can't overdraw", async () => {
    const p = await playerUser(w, "p@example.com");
    expect((await call("post", `/admin/users/${p.user.id}/credits`, admin.auth, { delta: 20, reason: "Welcome gift" })).body.data.balance).toBe(20);
    expect((await call("post", `/admin/users/${p.user.id}/credits`, admin.auth, { delta: -5, reason: "Refund" })).body.data.balance).toBe(15);
    const over = await call("post", `/admin/users/${p.user.id}/credits`, admin.auth, { delta: -100, reason: "Too much" });
    expect(over.status).toBe(402);
    expect(await balanceOf(p.user.id)).toBe(15);
    expect(await prisma.adminAction.count({ where: { action: "CREDITS_GRANT" } })).toBe(2);
    for (const bad of [{ delta: 0, reason: "nothing" }, { delta: 50_000, reason: "huge" }, { delta: 5 }]) expect((await call("post", `/admin/users/${p.user.id}/credits`, admin.auth, bad)).status).toBe(422);
  });

  it("creates, lists and edits packs", async () => {
    const created = await call("post", "/admin/credit-packs", admin.auth, { code: "mega", credits: 500, priceBdt: 2999 });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: "MEGA", isActive: true });
    expect((await call("post", "/admin/credit-packs", admin.auth, { code: "MEGA", credits: 1, priceBdt: 1 })).status).toBe(409);
    expect((await call("post", "/admin/credit-packs", admin.auth, { code: "FREE", credits: 5, priceBdt: 0 })).status).toBe(422);
    expect((await call("get", "/admin/credit-packs", admin.auth)).body.data).toHaveLength(4);
    expect((await call("put", `/admin/credit-packs/${created.body.data.id}`, admin.auth, {})).status).toBe(422);
  });

  it("every admin billing route is closed to non-admins", async () => {
    const rec = await recruiterUser(w);
    const player = await playerUser(w, "p@example.com");
    const paths: Array<["get" | "post" | "put", string]> = [["get", "/admin/payments"], ["post", "/admin/payments/x/approve"], ["post", "/admin/payments/x/reject"], ["post", `/admin/users/${player.user.id}/credits`], ["get", "/admin/credit-packs"], ["post", "/admin/credit-packs"], ["put", "/admin/credit-packs/x"], ["get", "/admin/verifications"], ["post", "/admin/verifications/x/review"], ["get", "/admin/conversations/x/transcript"]];
    for (const who of [rec, player]) for (const [m, path] of paths) expect((await call(m, path, who.auth)).status, `${m} ${path}`).toBe(403);
    for (const [m, path] of paths) expect((await api()[m](`${V1}${path}`).send({})).status, `anon ${m} ${path}`).toBe(401);
  });

  it("pricing set by an admin shows up in the public app config", async () => {
    await call("put", "/admin/app-config/contact_credits_enabled", admin.auth, { value: true });
    await call("put", "/admin/app-config/contact_free_per_day", admin.auth, { value: "3" });
    await call("put", "/admin/app-config/contact_credit_cost", admin.auth, { value: "2" });
    expect((await call("put", "/admin/app-config/boost_hours", admin.auth, { value: "0" })).status).toBe(422);
    expect((await call("put", "/admin/app-config/contact_credit_cost", admin.auth, { value: "lots" })).status).toBe(422);
    expect((await api().get(`${V1}/app-config`)).body.data.pricing).toMatchObject({ contactCreditsEnabled: true, freeContactsPerDay: 3, contactCreditCost: 2 });
    void setPricing; void signedIn;
  });
});
