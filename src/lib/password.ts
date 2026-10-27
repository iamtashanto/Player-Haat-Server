import { hash, verify } from "@node-rs/argon2";
import { env } from "../config/env.js";

// argon2id (the library default), OWASP 2023 minimum (19 MiB, t=2, p=1). Tests use a tiny cost so suites stay fast.
const options = env.isTest
  ? { memoryCost: 1024, timeCost: 1, parallelism: 1 }
  : { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (plain: string) => hash(plain, options);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false; // malformed hash must never crash a login
  }
}

// Verified against when the account doesn't exist, so "unknown email" costs the same as "wrong password".
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword("playerhaat-dummy-password");
  await verifyPassword(await dummyHash, plain);
}
