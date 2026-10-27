import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireRole } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./recruiters.schema.js";
import * as svc from "./recruiters.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;

/** Mounted at /recruiters, behind the app-user guard (players and recruiters). */
export const recruitersRoutes = Router();

// Managing a recruiter profile is for recruiters only (declared before /:id so "me" is never read as an id).
recruitersRoutes.use("/me", requireRole("RECRUITER"));
recruitersRoutes.get("/me", async (req, res) => ok(res, await svc.getMyRecruiterProfile(me(req))));
recruitersRoutes.post("/me", validate({ body: s.createRecruiterBody }), async (req, res) => {
  created(res, await svc.createRecruiterProfile(me(req), valid<B<typeof s.createRecruiterBody>>(req).body));
});
recruitersRoutes.patch("/me", validate({ body: s.updateRecruiterBody }), async (req, res) => {
  ok(res, await svc.updateRecruiterProfile(me(req), valid<B<typeof s.updateRecruiterBody>>(req).body));
});

recruitersRoutes.get("/:id", validate({ params: s.recruiterParams }), async (req, res) => {
  ok(res, await svc.getPublicRecruiter(valid<unknown, B<typeof s.recruiterParams>>(req).params.id));
});
