import { Router } from "express";
import { createApiLimits } from "./middlewares/rate-limit.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { appConfigRoutes } from "./modules/app-config/app-config.routes.js";
import { applicationsRoutes, requestApplicationsRoutes } from "./modules/applications/applications.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { locationsRoutes } from "./modules/locations/locations.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";
import { notificationsRoutes } from "./modules/notifications/notifications.routes.js";
import { playersRoutes } from "./modules/players/players.routes.js";
import { playerRatingsRoutes, ratingsRoutes, requestRatingsRoutes } from "./modules/ratings/ratings.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { requestsRoutes } from "./modules/requests/requests.routes.js";
import { sportsRoutes } from "./modules/sports/sports.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";

/** Mounted at /api/v1. Each phase adds its module router here. */
export const apiRouter = Router();

// Blanket limits first: per-IP for everyone, per-user for signed-in callers. Routers add tighter ones.
apiRouter.use(createApiLimits());


apiRouter.use("/auth", authRoutes);
apiRouter.use("/locations", locationsRoutes);
apiRouter.use("/sports", sportsRoutes);
apiRouter.use("/users", usersRoutes);
apiRouter.use("/players/:id/ratings", playerRatingsRoutes);
apiRouter.use("/players", playersRoutes);
apiRouter.use("/media", mediaRoutes);
apiRouter.use("/requests/:requestId/applications", requestApplicationsRoutes);
apiRouter.use("/requests/:requestId/ratings", requestRatingsRoutes);
apiRouter.use("/requests", requestsRoutes);
apiRouter.use("/applications", applicationsRoutes);
apiRouter.use("/notifications", notificationsRoutes);
apiRouter.use("/ratings", ratingsRoutes);
apiRouter.use("/reports", reportsRoutes);
apiRouter.use("/app-config", appConfigRoutes);
apiRouter.use("/admin", adminRoutes);
