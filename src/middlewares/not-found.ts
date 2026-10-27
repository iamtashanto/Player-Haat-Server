import type { RequestHandler } from "express";
import { AppError, ErrorCode } from "../lib/errors.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(ErrorCode.ROUTE_NOT_FOUND, 404, `Cannot ${req.method} ${req.path}`));
};
