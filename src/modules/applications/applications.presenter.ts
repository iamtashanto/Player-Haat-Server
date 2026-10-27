import type { Prisma } from "@prisma/client";
import { profileInclude, toPlayerCard } from "../players/players.presenter.js";
import { requestInclude, toRequest } from "../requests/requests.presenter.js";

export const applicantInclude = {
  player: { select: { id: true, name: true, avatarUrl: true, phone: true, playerProfile: { include: profileInclude } } },
} satisfies Prisma.ApplicationInclude;
export type ApplicantRow = Prisma.ApplicationGetPayload<{ include: typeof applicantInclude }>;

export const myApplicationInclude = {
  request: { include: { ...requestInclude, createdBy: { select: { ...requestInclude.createdBy.select, phone: true } } } },
} satisfies Prisma.ApplicationInclude;
export type MyApplicationRow = Prisma.ApplicationGetPayload<{ include: typeof myApplicationInclude }>;

const base = (a: { id: string; status: string; proposedRate: number | null; message: string | null; createdAt: Date; respondedAt: Date | null }) => ({
  id: a.id,
  status: a.status,
  proposedRate: a.proposedRate,
  message: a.message,
  createdAt: a.createdAt.toISOString(),
  respondedAt: a.respondedAt?.toISOString() ?? null,
});

/** The poster's view of an applicant. The player's phone appears only after they've been accepted. */
export function toApplicant(a: ApplicantRow) {
  const profile = a.player.playerProfile;
  return {
    ...base(a),
    player: profile ? { ...toPlayerCard(profile), id: profile.id } : null,
    ...(a.status === "ACCEPTED" && { contact: { phone: a.player.phone } }),
  };
}

/** The player's view of their own application. The poster's phone appears only once accepted. */
export function toMyApplication(a: MyApplicationRow) {
  const { phone, ...creator } = a.request.createdBy;
  return {
    ...base(a),
    request: toRequest({ ...a.request, createdBy: creator }, { viewerId: a.playerId }),
    ...(a.status === "ACCEPTED" && { contact: { phone } }),
  };
}
