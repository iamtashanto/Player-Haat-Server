import { Router } from "express";
import { liveness, readiness } from "./health.controller.js";
import "./health.schema.js"; // registers the OpenAPI paths

export const healthRoutes = Router();

healthRoutes.get("/", liveness);
healthRoutes.get("/ready", readiness);
