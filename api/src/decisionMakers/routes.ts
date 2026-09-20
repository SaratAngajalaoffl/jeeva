import { Router } from "express";
import { requireAuth } from "../auth/requireAuth.js";
import { getDecisionMakerStatuses } from "./status.js";

export function createDecisionMakersRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/status", async (_req, res) => {
    const statuses = await getDecisionMakerStatuses();
    res.status(200).json({ statuses });
  });

  return router;
}
