import { hash } from "@node-rs/argon2";
import type { PrismaClient } from "@prisma/client";

const DAY = 24 * 60 * 60 * 1000;

/** Local-development password for every demo user. Demo seeding is refused in production. */
export const DEMO_PASSWORD = "Demo1234";

/**
 * Demo data around Kuakata / Kalapara (Patuakhali). They exist so
 * search, requests and applications have something to return. They can log in with DEMO_PASSWORD.
 * Emails use the reserved `.test` TLD so nothing can ever be delivered to them.
 */
export async function seedDemo(prisma: PrismaClient) {
  const district = await prisma.district.findFirstOrThrow({ where: { slug: "patuakhali" } });
  const kalapara = await prisma.upazila.findFirstOrThrow({
    where: { districtId: district.id, slug: "kalapara" },
  });
  const latachapli = await prisma.union.findFirst({ where: { upazilaId: kalapara.id, slug: "latachapli" } });
  const football = await prisma.sport.findUniqueOrThrow({ where: { code: "FOOTBALL" } });
  const cricket = await prisma.sport.findUniqueOrThrow({ where: { code: "CRICKET" } });

  const home = {
    districtId: district.id,
    upazilaId: kalapara.id,
    unionId: latachapli?.id ?? null,
  };

  const people = [
    { name: "Rakib Hasan", email: "rakib@demo.playerhaat.test", sport: null },
    {
      name: "Sohel Rana",
      email: "sohel@demo.playerhaat.test",
      sport: { sportId: football.id, positions: ["GK"], skillLevel: 4, khep: true, rateMin: 400, rateMax: 600 },
    },
    {
      name: "Imran Hossain",
      email: "imran@demo.playerhaat.test",
      sport: { sportId: football.id, positions: ["ST", "WING"], skillLevel: 3, khep: true, rateMin: 300, rateMax: 500 },
    },
    {
      name: "Tuhin Akon",
      email: "tuhin@demo.playerhaat.test",
      sport: { sportId: football.id, positions: ["CM", "DM"], skillLevel: 3, khep: false, rateMin: null, rateMax: null },
    },
    {
      name: "Mahin Sarder",
      email: "mahin@demo.playerhaat.test",
      sport: { sportId: cricket.id, positions: ["BATTER"], skillLevel: 4, khep: true, rateMin: 500, rateMax: 800 },
    },
  ];

  const passwordHash = await hash(DEMO_PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const users: Record<string, string> = {};
  for (const p of people) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: {
        name: p.name,
        email: p.email,
        emailVerifiedAt: new Date(),
        locale: "bn",
        passwordHash,
        authAccounts: { create: { provider: "EMAIL", providerUserId: p.email } },
      },
    });
    users[p.name] = user.id;

    if (!p.sport) continue;
    const profile = await prisma.playerProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, bio: "Demo player from Kalapara.", ...home },
    });
    await prisma.playerSport.upsert({
      where: { profileId_sportId: { profileId: profile.id, sportId: p.sport.sportId } },
      update: {},
      create: {
        profileId: profile.id,
        sportId: p.sport.sportId,
        positions: p.sport.positions,
        skillLevel: p.sport.skillLevel,
        khepAvailable: p.sport.khep,
        rateMin: p.sport.rateMin,
        rateMax: p.sport.rateMax,
        availability: { fri: ["afternoon", "evening"], sat: ["morning"] },
        travelRadius: "UPAZILA",
      },
    });
  }

  const captainId = users["Rakib Hasan"]!;
  const requests = [
    {
      sportId: football.id,
      venueText: "Kuakata Sea Beach Ground, Latachapli",
      matchAt: new Date(Date.now() + 3 * DAY),
      positionsNeeded: ["GK", "ST"],
      playersNeeded: 2,
      isPaid: true,
      budgetMin: 300,
      budgetMax: 500,
      notes: "Friendly 7-a-side. Bring your own boots.",
    },
    {
      sportId: cricket.id,
      venueText: "Kalapara Government College Field",
      matchAt: new Date(Date.now() + 5 * DAY),
      positionsNeeded: ["BATTER", "BOWLER"],
      playersNeeded: 3,
      isPaid: false,
      budgetMin: null,
      budgetMax: null,
      notes: "Tape-ball tournament round 1.",
    },
  ];
  for (const r of requests) {
    const exists = await prisma.playerRequest.findFirst({
      where: { createdById: captainId, venueText: r.venueText },
    });
    if (!exists) await prisma.playerRequest.create({ data: { createdById: captainId, ...home, ...r } });
  }

  return { users: people.length, requests: requests.length };
}
