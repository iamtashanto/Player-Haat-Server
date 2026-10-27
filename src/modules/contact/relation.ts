import { prisma } from "../../lib/prisma.js";

/**
 * Have these two people agreed to deal with each other? True when one accepted the other's application, or
 * a player accepted a recruiter's invite. Used to unlock numbers and chat regardless of privacy settings,
 * because an acceptance is consent.
 */
export async function haveAcceptedRelation(a: string, b: string): Promise<boolean> {
  const [application, invite] = await Promise.all([
    prisma.application.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { playerId: a, request: { createdById: b } },
          { playerId: b, request: { createdById: a } },
        ],
      },
      select: { id: true },
    }),
    prisma.invite.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { recruiterId: a, profile: { userId: b } },
          { recruiterId: b, profile: { userId: a } },
        ],
      },
      select: { id: true },
    }),
  ]);
  return application !== null || invite !== null;
}
