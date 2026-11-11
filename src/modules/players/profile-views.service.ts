import { prisma } from "../../lib/prisma.js";
import { clock } from "../../lib/clock.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { notify } from "../notifications/notifier.js";

const dhakaDay = (now: Date) => new Date(Math.floor((now.getTime() + 6 * 3_600_000) / 86_400_000) * 86_400_000); // 00:00 UTC of the Dhaka calendar date

/**
 * A recruiter opening a player's profile counts once per recruiter per player per Dhaka day. Players, admins and
 * signed-out visitors are never recorded. The first view of the day tells the player (if they allow it).
 */
export async function recordProfileView(viewerId: string, profileId: string, ownerUserId: string) {
  if (viewerId === ownerUserId) return;
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { role: true, name: true, status: true, recruiterProfile: { select: { organization: true } } } });
  if (!viewer || viewer.role !== "RECRUITER" || viewer.status !== "ACTIVE") return;
  const { count } = await prisma.profileView.createMany({ data: [{ profileId, viewerId, day: dhakaDay(clock.now()) }], skipDuplicates: true });
  if (count === 0) return; // already counted today
  notify({
    userIds: [ownerUserId],
    type: "PROFILE_VIEWED",
    data: { profileId },
    params: { actor: viewer.recruiterProfile?.organization ? `${viewer.name} · ${viewer.recruiterProfile.organization}` : viewer.name },
  });
}

/** "Who viewed my profile": newest first, one row per recruiter per day. */
export async function myProfileViews(userId: string, q: { cursor?: string; limit: number }) {
  const rows = await prisma.profileView.findMany({
    where: { profile: { userId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { viewer: { select: { name: true, avatarUrl: true, role: true, recruiterProfile: { select: { id: true, type: true, organization: true, verifiedBadge: true, logoUrl: true } } } } },
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      viewer: {
        name: r.viewer.name,
        avatarUrl: r.viewer.avatarUrl,
        role: r.viewer.role,
        recruiterId: r.viewer.recruiterProfile?.id ?? null,
        recruiterType: r.viewer.recruiterProfile?.type ?? null,
        organization: r.viewer.recruiterProfile?.organization ?? null,
        verified: r.viewer.recruiterProfile?.verifiedBadge ?? false,
      },
    })),
    nextCursor,
  };
}
