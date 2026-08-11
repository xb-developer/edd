import express from "express";
import cors from "cors";
import { documentsRouter } from "./routes/documents.js";
import { assemblyRouter } from "./routes/assembly.js";
import { caseHeadingRouter } from "./routes/caseHeading.js";
import "./db.js"; // ensure schema is created on startup

const PORT = process.env.ASSEMBLE_SERVER_PORT ? Number(process.env.ASSEMBLE_SERVER_PORT) : 4410;

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/documents", documentsRouter);
app.use("/api/assembly", assemblyRouter);
app.use("/api/case-heading", caseHeadingRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`XBundle Assemble server listening on http://localhost:${PORT}`);
});
