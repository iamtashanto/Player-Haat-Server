import type { RequestHandler } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/**
 * Parses body/params/query with Zod and stores the *parsed* result on `req.valid`
 * (Express 5 makes `req.query` read-only, so we don't overwrite it). A ZodError is
 * turned into a 422 VALIDATION_ERROR by the central error handler.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    req.valid = {
      body: schemas.body ? schemas.body.parse(req.body) : req.body,
      params: schemas.params ? schemas.params.parse(req.params) : req.params,
      query: schemas.query ? schemas.query.parse(req.query) : req.query,
    };
    next();
  };
