import type { AuthAccount, User } from "@prisma/client";

export type UserWithAccounts = User & { authAccounts: Pick<AuthAccount, "provider">[] };

/** The user shape returned by every auth endpoint. Never includes hashes or internal ids. */
export function toAuthUser(u: UserWithAccounts) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerifiedAt !== null,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    locale: u.locale,
    role: u.role,
    hasPassword: u.passwordHash !== null,
    loginMethods: u.authAccounts.map((a) => a.provider),
  };
}
