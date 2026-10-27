import { Router } from "express";
import { requireAppUser } from "./middlewares/auth.js";
import { createApiLimits } from "./middlewares/rate-limit.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { appConfigRoutes } from "./modules/app-config/app-config.routes.js";
import { applicationsRoutes, requestApplicationsRoutes } from "./modules/applications/applications.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { locationsRoutes } from "./modules/locations/locations.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";
import { notificationsRoutes } from "./modules/notifications/notifications.routes.js";
import { playersRoutes } from "./modules/players/players.routes.js";
import { recruiterTypesRoutes } from "./modules/recruiters/recruiter-types.routes.js";
import { recruitersRoutes } from "./modules/recruiters/recruiters.routes.js";
import { playerRatingsRoutes, ratingsRoutes, requestRatingsRoutes } from "./modules/ratings/ratings.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { requestsRoutes } from "./modules/requests/requests.routes.js";
import { sportsRoutes } from "./modules/sports/sports.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";

/** Mounted at /api/v1. Each phase adds its module router here. */
export const apiRouter = Router();

// Blanket limits first: per-IP for everyone, per-user for signed-in callers. Routers add tighter ones.
apiRouter.use(createApiLimits());


// Public / identity-level: auth (sign-in, token refresh, password) and read-only reference data.
apiRouter.use("/auth", authRoutes);
apiRouter.use("/locations", locationsRoutes);
apiRouter.use("/sports", sportsRoutes);
apiRouter.use("/recruiter-types", recruiterTypesRoutes);
apiRouter.use("/app-config", appConfigRoutes);

// The mobile app's API. Mounted behind the role guard so a new router can't be exposed to admins by
// forgetting it; routers add stricter guards (player-only, recruiter-only) where a feature needs one.
apiRouter.use("/users", requireAppUser, usersRoutes);
apiRouter.use("/players/:id/ratings", requireAppUser, playerRatingsRoutes);
apiRouter.use("/players", requireAppUser, playersRoutes);
apiRouter.use("/recruiters", requireAppUser, recruitersRoutes);
apiRouter.use("/media", requireAppUser, mediaRoutes);
apiRouter.use("/requests/:requestId/applications", requireAppUser, requestApplicationsRoutes);
apiRouter.use("/requests/:requestId/ratings", requireAppUser, requestRatingsRoutes);
apiRouter.use("/requests", requireAppUser, requestsRoutes);
apiRouter.use("/applications", requireAppUser, applicationsRoutes);
apiRouter.use("/notifications", requireAppUser, notificationsRoutes);
apiRouter.use("/ratings", requireAppUser, ratingsRoutes);
apiRouter.use("/reports", requireAppUser, reportsRoutes);

// The dashboard's API: ADMIN only (its own login lives inside this router).
apiRouter.use("/admin", adminRoutes);
