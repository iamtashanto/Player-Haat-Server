import "express";

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `validate` middleware with the Zod-parsed body/params/query. */
      /** Set by `requireAuth`: the authenticated user (role is read fresh from the DB, not the token). */
      /** Set early by `identifyCaller` from a verified access token; used only to key rate limits. */
      callerId?: string;
      auth?: { userId: string; role: "USER" | "ADMIN" };
      valid: { body: unknown; params: unknown; query: unknown };
    }
  }
}

export {};
