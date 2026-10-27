import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifier.js";
import { lockRequest } from "../requests/request-lock.js";
import type { RequestRow } from "../requests/requests.presenter.js";
import {
  applicantInclude,
  myApplicationInclude,
  toApplicant,
  toMyApplication,
} from "./applications.presenter.js";
import type { applyBody } from "./applications.schema.js";

const display = (r: RequestRow) => ({ sport: { bn: r.sport.nameBn, en: r.sport.nameEn }, venue: r.venueText, when: r.matchAt });

const loadApplicant = (id: string) =>
  prisma.application.findUniqueOrThrow({ where: { id }, include: applicantInclude }).then(toApplicant);

/** Requests that must not accept (more) people. Order matters: the most specific reason wins. */
function assertAcceptingPeople(r: RequestRow) {
  if (r.status === "FILLED") throw AppError.conflict("REQUEST_FILLED", "This request is already filled");
  if (r.status !== "OPEN") throw AppError.conflict("REQUEST_NOT_OPEN", `This request is ${r.status.toLowerCase()}`);
  if (r.matchAt.getTime() <= Date.now()) throw AppError.conflict("REQUEST_EXPIRED", "This match has already started");
}

// ───────────────────────── apply ─────────────────────────

export async function apply(userId: string, requestId: string, input: z.infer<typeof applyBody>) {
  const profile = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true, user: { select: { name: true } } } });
  if (!profile) throw AppError.conflict("PLAYER_PROFILE_REQUIRED", "Create your player profile before applying");

  const { application, request } = await prisma.$transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    const posterActive = (await tx.user.findUnique({ where: { id: request.createdById }, select: { status: true } }))?.status === "ACTIVE";
    if (request.isHidden || !posterActive) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
    if (request.createdById === userId) throw AppError.forbidden("REQUEST_OWN", "You can't apply to your own request");
    assertAcceptingPeople(request);

    const plays = await tx.playerSport.findUnique({
      where: { profileId_sportId: { profileId: profile.id, sportId: request.sportId } },
      select: { id: true },
    });
    if (!plays) throw AppError.conflict("PLAYER_SPORT_REQUIRED", `Add ${request.sport.nameEn} to your profile before applying`);

    const proposedRate = input.proposedRate ?? null;
    if (proposedRate !== null && !request.isPaid) throw AppError.invalid("proposedRate", "This request is unpaid");
    const message = input.message ?? null;

    const existing = await tx.application.findUnique({ where: { requestId_playerId: { requestId, playerId: userId } } });
    if (existing && existing.status !== "WITHDRAWN") {
      throw AppError.conflict("APPLICATION_EXISTS", `You already applied (${existing.status.toLowerCase()})`);
    }
    // Re-applying after a withdrawal revives the same row (unique per request + player).
    const application = existing
      ? await tx.application.update({ where: { id: existing.id }, data: { status: "PENDING", proposedRate, message, respondedAt: null } })
      : await tx.application.create({ data: { requestId, playerId: userId, proposedRate, message } });
    return { application, request };
  });

  notify({
    userIds: [request.createdById],
    type: "NEW_APPLICANT",
    data: { requestId, applicationId: application.id },
    params: { ...display(request), actor: profile.user.name },
  });
  return loadApplicant(application.id);
}

// ───────────────────────── poster: list / accept / reject ─────────────────────────

async function assertPoster(requestId: string, userId: string) {
  const r = await prisma.playerRequest.findUnique({ where: { id: requestId }, select: { createdById: true } });
  if (!r) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  if (r.createdById !== userId) throw AppError.forbidden("REQUEST_NOT_OWNER", "Only the poster can see applicants");
}

export async function listApplicants(userId: string, requestId: string, q: { cursor?: string; limit: number; status?: string }) {
  await assertPoster(requestId, userId);
  const rows = await prisma.application.findMany({
    where: { requestId, ...(q.status && { status: q.status as "PENDING" }) },
    include: applicantInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toApplicant), nextCursor };
}

/** Shared by accept/reject: lock the request, verify the poster, re-read the application under the lock. */
async function withLockedApplication<T>(
  userId: string,
  applicationId: string,
  fn: (ctx: { tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]; request: RequestRow; app: { id: string; status: string; playerId: string } }) => Promise<T>,
) {
  const found = await prisma.application.findUnique({ where: { id: applicationId }, select: { requestId: true } });
  if (!found) throw AppError.notFound("APPLICATION_NOT_FOUND", "Application not found");
  return prisma.$transaction(async (tx) => {
    const request = await lockRequest(tx, found.requestId);
    if (request.createdById !== userId) throw AppError.forbidden("REQUEST_NOT_OWNER", "Only the poster can do that");
    const app = await tx.application.findUniqueOrThrow({ where: { id: applicationId }, select: { id: true, status: true, playerId: true } });
    return fn({ tx, request, app });
  });
}

export async function accept(userId: string, applicationId: string) {
  const out = await withLockedApplication(userId, applicationId, async ({ tx, request, app }) => {
    if (app.status === "ACCEPTED") return { request, app, changed: false }; // idempotent retry
    if (app.status !== "PENDING") throw AppError.conflict("APPLICATION_NOT_PENDING", `Application is ${app.status.toLowerCase()}`);
    assertAcceptingPeople(request);

    await tx.application.update({ where: { id: app.id }, data: { status: "ACCEPTED", respondedAt: new Date() } });
    const accepted = request.playersAccepted + 1;
    await tx.playerRequest.update({
      where: { id: request.id },
      data: { playersAccepted: accepted, ...(accepted >= request.playersNeeded && { status: "FILLED" }) },
    });
    return { request, app, changed: true };
  });

  if (out.changed) {
    notify({
      userIds: [out.app.playerId],
      type: "APPLICATION_ACCEPTED",
      data: { requestId: out.request.id, applicationId },
      params: display(out.request),
    });
  }
  return loadApplicant(applicationId);
}

export async function reject(userId: string, applicationId: string) {
  const out = await withLockedApplication(userId, applicationId, async ({ tx, request, app }) => {
    if (app.status === "REJECTED") return { request, app, changed: false };
    if (app.status !== "PENDING") throw AppError.conflict("APPLICATION_NOT_PENDING", `Application is ${app.status.toLowerCase()}`);
    await tx.application.update({ where: { id: app.id }, data: { status: "REJECTED", respondedAt: new Date() } });
    return { request, app, changed: true };
  });

  if (out.changed) {
    notify({
      userIds: [out.app.playerId],
      type: "APPLICATION_REJECTED",
      data: { requestId: out.request.id, applicationId },
      params: display(out.request),
    });
  }
  return loadApplicant(applicationId);
}

// ───────────────────────── player: withdraw / list ─────────────────────────

export async function withdraw(userId: string, applicationId: string) {
  const found = await prisma.application.findFirst({
    where: { id: applicationId, playerId: userId },
    select: { requestId: true, player: { select: { name: true } } },
  });
  if (!found) throw AppError.notFound("APPLICATION_NOT_FOUND", "Application not found");

  const out = await prisma.$transaction(async (tx) => {
    const request = await lockRequest(tx, found.requestId);
    const app = await tx.application.findUniqueOrThrow({ where: { id: applicationId } });
    if (app.status === "WITHDRAWN") return { request, wasAccepted: false, changed: false };
    if (app.status === "REJECTED") throw AppError.conflict("APPLICATION_NOT_PENDING", "Application was rejected");
    if (request.status !== "OPEN" && request.status !== "FILLED") {
      throw AppError.conflict("REQUEST_CLOSED", `This request is ${request.status.toLowerCase()}`);
    }

    const wasAccepted = app.status === "ACCEPTED";
    await tx.application.update({ where: { id: app.id }, data: { status: "WITHDRAWN", respondedAt: new Date() } });
    if (wasAccepted) {
      const accepted = Math.max(0, request.playersAccepted - 1);
      await tx.playerRequest.update({
        where: { id: request.id },
        // A spot opened up: a FILLED request that now has room goes back to OPEN.
        data: { playersAccepted: accepted, ...(request.status === "FILLED" && accepted < request.playersNeeded && { status: "OPEN" }) },
      });
    }
    return { request, wasAccepted, changed: true };
  });

  if (out.changed && out.wasAccepted) {
    notify({
      userIds: [out.request.createdById],
      type: "APPLICATION_WITHDRAWN",
      data: { requestId: out.request.id, applicationId },
      params: { ...display(out.request), actor: found.player.name },
    });
  }
  return loadApplicant(applicationId);
}

export async function myApplications(userId: string, q: { cursor?: string; limit: number; status?: string }) {
  const rows = await prisma.application.findMany({
    where: { playerId: userId, ...(q.status && { status: q.status as "PENDING" }) },
    include: myApplicationInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toMyApplication), nextCursor };
}
