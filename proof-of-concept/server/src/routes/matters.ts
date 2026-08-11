import { Router } from "express";
import { createMatter, deleteMatter, getActiveMatter, listMatters, openMatter } from "../db.js";

export const mattersRouter = Router();

mattersRouter.get("/", (_req, res) => {
  res.json({ matters: listMatters(), active: getActiveMatter() ?? null });
});

mattersRouter.post("/", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  try {
    const info = createMatter(name);
    res.status(201).json(info);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

mattersRouter.post("/:id/open", (req, res) => {
  try {
    const info = openMatter(req.params.id);
    res.json(info);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Returns the same shape as GET / (matters + active) so the client can tell
// in one response whether the matter it just deleted was the active one.
mattersRouter.delete("/:id", (req, res) => {
  try {
    deleteMatter(req.params.id);
    res.json({ matters: listMatters(), active: getActiveMatter() ?? null });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
