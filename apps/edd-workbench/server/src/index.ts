// Must be the very first import — auth.ts and edd-workbench-core's pool.ts
// both read required env vars at module-load time, so .env has to be loaded
// before either of those modules is evaluated (see edd-workbench-core's
// loadEnv.ts for why this can't just be a plain dotenv.config() call here).
import "@xbundle/edd-workbench-core/src/loadEnv.js";
import express from "express";
import cors from "cors";
import { requireValidToken, resolveOrgContext, requireMatterAccess } from "./auth.js";
import { myOrganizationsRouter } from "./routes/myOrganizations.js";
import { mattersRouter } from "./routes/matters.js";
import { documentsRouter } from "./routes/documents.js";
import { tagsRouter } from "./routes/tags.js";
import { documentTagsRouter } from "./routes/documentTags.js";
import { exportsRouter } from "./routes/exports.js";
import { matterMembersRouter } from "./routes/matterMembers.js";
import { matterAuditRouter } from "./routes/matterAudit.js";
import { askRouter } from "./routes/ask.js";
import { searchRouter } from "./routes/search.js";
import { auditRouter } from "./routes/audit.js";
import { workerStatusRouter } from "./routes/workerStatus.js";
import { aiUsageRouter } from "./routes/aiUsage.js";
import { searchHealthRouter } from "./routes/searchHealth.js";

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
// Framework fingerprinting is free reconnaissance for an attacker — no
// functional cost to withholding it.
app.disable("x-powered-by");
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

// requireValidToken only, deliberately ahead of the blanket resolveOrgContext
// mount below — the whole point of this route is answering "which
// Organization does this identity belong to" for a token that was issued
// via a PLAIN login (no organization specified yet, so no org_id claim to
// resolve). See main.tsx's own comment: the client logs in once with no
// organization, calls this, then does a second loginWithRedirect scoped to
// the resolved org — Auth0 has no supported way to get an org-scoped token
// silently, so this round trip is unavoidable, not a workaround.
app.use("/api/my-organizations", requireValidToken, myOrganizationsRouter);

app.use("/api", requireValidToken, resolveOrgContext);

// The client has no other way to learn its own local identity (userId/role)
// — it only ever sees Auth0's own sub/email otherwise. Needed so the UI can
// decide things like "am I allowed to manage this matter's access list"
// without duplicating that admin-or-creator logic into every matter DTO.
app.get("/api/me", (req, res) => {
  res.json(req.eddContext);
});

app.use("/api/audit", auditRouter);
app.use("/api/ai-usage", aiUsageRouter);
app.use("/api/search-health", searchHealthRouter);
app.use("/api/matters", mattersRouter);
// Every :matterId-scoped router below sits behind requireMatterAccess —
// mounted once, on the shared path prefix, rather than repeated per router.
// mattersRouter above is NOT behind it: matter creation/listing have no
// :matterId yet, and PATCH /:matterId (rename) calls requireMatterAccess()
// directly since its own mount is bare "/api/matters".
app.use("/api/matters/:matterId", requireMatterAccess());
app.use("/api/matters/:matterId/documents", documentsRouter);
app.use("/api/matters/:matterId/tags", tagsRouter);
app.use("/api/matters/:matterId/document-tags", documentTagsRouter);
app.use("/api/matters/:matterId/exports", exportsRouter);
app.use("/api/matters/:matterId/members", matterMembersRouter);
app.use("/api/matters/:matterId/audit", matterAuditRouter);
app.use("/api/matters/:matterId/ask", askRouter);
app.use("/api/matters/:matterId/search", searchRouter);
// Moved from the old bare "/api/worker-status" — its queued/ok/failed
// counts are this matter's own now (see workerStatus.ts's own comment),
// so it needs requireMatterAccess() like every other router on this line.
app.use("/api/matters/:matterId/worker-status", workerStatusRouter);

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
