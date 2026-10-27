import type { Request, Response } from "express";

/** Standard success envelope: `{ data, meta }`. */
export function ok<T>(res: Response, data: T, meta: Record<string, unknown> = {}, status = 200) {
  return res.status(status).json({ data, meta });
}

export const created = <T>(res: Response, data: T, meta: Record<string, unknown> = {}) =>
  ok(res, data, meta, 201);

/** Typed access to what the `validate` middleware parsed. */
export function valid<B = unknown, P = unknown, Q = unknown>(req: Request) {
  return req.valid as { body: B; params: P; query: Q };
}
