import { Router } from "express";
import { askMatter } from "../rag/ask.js";
import { logAuditForRequest } from "../audit/log.js";

export const askRouter = Router();

askRouter.post("/matters/:matterId/ask", async (req, res) => {
  const { matterId } = req.params;
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  try {
    const result = await askMatter(req.tenant!, matterId, question);
    // Metadata only - the question/answer text is privileged matter content
    // and does not belong duplicated into a second table.
    logAuditForRequest(req, { matterId, action: "matter.ask", allowed: true, detail: { questionLength: question.length } });
    res.json(result);
  } catch (err) {
    console.error("ask failed:", err);
    res.status(500).json({ error: "ask_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});
