import type { RequestHandler } from "express";

/** Public, shareable caching for static reference data (Express adds the ETag). */
export const cacheReference =
  (maxAgeSec: number): RequestHandler =>
  (_req, res, next) => {
    res.setHeader("Cache-Control", `public, max-age=${maxAgeSec}`);
    next();
  };
