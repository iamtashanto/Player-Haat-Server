import { randomInt } from "node:crypto";

/** Smallest power of two that holds `n` teams. */
export const bracketSize = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
export const roundCount = (size: number) => Math.log2(size);

/** Standard knockout order: seed 1 meets the weakest seed, and the top seeds can only meet late. 8 → 1,8,4,5,2,7,3,6. */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((s) => [s, next + 1 - s]);
  }
  return order;
}

/** A fair draw: the registration order does not help anybody, and seeds beyond the number of teams are byes. */
export function shuffle<T>(items: T[], rnd: (n: number) => number = randomInt): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface Slot { round: number; slot: number; home: string | null; away: string | null }

/** Every match of the tournament, empty beyond the first round. First-round pairs follow the seed order. */
export function drawBracket(teamIds: string[], rnd?: (n: number) => number): Slot[] {
  const size = bracketSize(teamIds.length);
  const seeded = shuffle(teamIds, rnd);
  const order = seedOrder(size);
  const out: Slot[] = [];
  for (let i = 0; i < size / 2; i++) out.push({ round: 1, slot: i, home: seeded[order[2 * i]! - 1] ?? null, away: seeded[order[2 * i + 1]! - 1] ?? null });
  for (let r = 2, n = size / 4; n >= 1; r++, n /= 2) for (let i = 0; i < n; i++) out.push({ round: r, slot: i, home: null, away: null });
  return out;
}
