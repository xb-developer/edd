// Must be the very first import — auth.ts and edd-workbench-core's pool.ts
// both read required env vars at module-load time, so .env has to be loaded
// before either of those modules is evaluated (see edd-workbench-core's
// loadEnv.ts for why this can't just be a plain dotenv.config() call here).
import "@xbundle/edd-workbench-core/src/loadEnv.js";
import express from "express";
import cors from "cors";
import { requireValidToken, resolveOrgContext } from "./auth.js";
import { mattersRouter } from "./routes/matters.js";
import { orgInvitesRouter } from "./routes/orgInvites.js";
import { documentsRouter } from "./routes/documents.js";
import { tagsRouter } from "./routes/tags.js";
import { documentTagsRouter } from "./routes/documentTags.js";
import { exportsRouter } from "./routes/exports.js";

const PORT = process.env.EDD_WORKBENCH_SERVER_PORT ? Number(process.env.EDD_WORKBENCH_SERVER_PORT) : 4430;

// Exported (not just listened on) so the full-pipeline test can drive real
// HTTP requests against it via supertest without binding an actual port.
// The app is served same-origin in every real deployment (CloudFront fronts
// both the SPA and /api/*, per the CDK stack's own design) — browsers never
// need CORS for the app's own normal traffic. This only matters for local
// dev, where the Vite client (localhost:5283) and this server (localhost:4430)
// are genuinely different origins. Defaults to that one dev origin so local
// dev keeps working with no config; CORS_ALLOWED_ORIGINS (comma-separated)
// lets a real deployment name its actual origins explicitly instead of the
// previous unrestricted `cors()` default, which reflected any origin.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5283").split(",").map((o) => o.trim());

export const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Every /api/* response is either identity-scoped (matters, documents —
// different per caller, per org) or a health check that must always hit
// the live service, never a stale cached answer. Express auto-generates an
// ETag for every res.json() call with no Cache-Control of its own, which
// is enough for a browser to apply heuristic caching to a GET even with no
// explicit Cache-Control present. That's exactly what happened: a browser
// sent If-None-Match on a later /api/matters request, the freshly computed
// (correct, successfully authenticated) response happened to match the
// cached ETag from the same still-empty list, and Express legitimately
// answered 304 — technically correct HTTP, wrong for an API where the
// client needs the real body on every request, not a cache's word that
// it's unchanged.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Unauthenticated — a load balancer/CloudFront health check must not require
// a valid Auth0 token.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", requireValidToken, resolveOrgContext);
app.use("/api/matters", mattersRouter);
app.use("/api/org/invitations", orgInvitesRouter);
app.use("/api/matters/:matterId/documents", documentsRouter);
app.use("/api/matters/:matterId/tags", tagsRouter);
app.use("/api/matters/:matterId/document-tags", documentTagsRouter);
app.use("/api/matters/:matterId/exports", exportsRouter);

interface HttpError {
  status?: number;
  statusCode?: number;
  message?: string;
  headers?: Record<string, string>;
}

// Centralized error handler — resolveOrgContext and route handlers both
// forward unexpected errors via next(err) rather than leaking raw error
// shapes/stack traces to the client. express-oauth2-jwt-bearer throws its
// own UnauthorizedError (status 401, plus a WWW-Authenticate header) for a
// missing/invalid/expired token — that's an expected, client-facing
// outcome, not a server fault, so it and any other well-formed 4xx get
// relayed as-is rather than flattened into an opaque 500. Anything else
// (a real bug, a DB error) stays a generic 500 — its message isn't safe to
// expose.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const httpErr = err as HttpError;
  const status = httpErr?.status ?? httpErr?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    if (httpErr.headers) res.set(httpErr.headers);
    res.status(status).json({ error: httpErr.message ?? "Request failed" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`EDD Workbench server listening on http://localhost:${PORT}`);
});
