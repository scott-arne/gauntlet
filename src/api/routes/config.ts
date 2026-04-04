import { Hono } from "hono";

export function configRoutes() {
  const router = new Hono();

  router.get("/", (c) => {
    const modelsList = process.env.GAUNTLET_MODELS;
    const agentModel = process.env.GAUNTLET_AGENT_MODEL;

    let models: string[] = [];
    if (modelsList) {
      models = modelsList.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (agentModel) {
      models = [agentModel];
    }

    const defaultModel = agentModel || models[0] || null;

    return c.json({ models, defaultModel });
  });

  return router;
}
