import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { getActiveMatter } from "./db.js";
import { mattersRouter } from "./routes/matters.js";
import { documentsRouter } from "./routes/documents.js";
import { tagsRouter } from "./routes/tags.js";
import { contentRouter } from "./routes/content.js";
import { exportRouter } from "./routes/export.js";
import { askRouter } from "./routes/ask.js";
import { startEmbeddingWorker } from "./lib/embeddingWorker.js";

const PORT = process.env.EDD_SERVER_PORT ? Number(process.env.EDD_SERVER_PORT) : 4420;

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/matters", mattersRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function requireMatter(req: Request, res: Response, next: NextFunction) {
  if (!getActiveMatter()) {
    return res.status(409).json({ error: "No matter is open. Open or create a matter first." });
  }
  next();
}

app.use("/api/documents", requireMatter, documentsRouter);
app.use("/api/documents", requireMatter, contentRouter);
app.use("/api/tags", requireMatter, tagsRouter);
app.use("/api/export", requireMatter, exportRouter);
app.use("/api/ask", requireMatter, askRouter);

app.listen(PORT, () => {
  console.log(`EDD Workbench server listening on http://localhost:${PORT}`);
});

startEmbeddingWorker();
