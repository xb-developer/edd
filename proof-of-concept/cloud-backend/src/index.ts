import "dotenv/config";
import cors from "cors";
import express from "express";
import { requireAuth } from "./auth/jwt.js";
import { devAuthBypass, isDevAuthBypassEnabled } from "./auth/devBypass.js";
import { resolveTenant } from "./middleware/tenant.js";
import { handleUploadError } from "./middleware/uploadError.js";
import { adminRouter } from "./routes/admin.js";
import { usersRouter } from "./routes/users.js";
import { groupsRouter } from "./routes/groups.js";
import { mattersRouter } from "./routes/matters.js";
import { documentsRouter, localDownloadRouter, MAX_UPLOAD_BYTES } from "./routes/documents.js";
import { tagsRouter } from "./routes/tags.js";
import { askRouter } from "./routes/ask.js";
import { leadsRouter } from "./routes/leads.js";
import { auditLogRouter } from "./routes/auditLog.js";

const app = express();
app.use(cors());
app.use(express.json());

// Outside /api and outside auth - hit directly by the ALB target group's
// health check, never routed through CloudFront.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Everything else lives under /api so CloudFront can route a single
// hostname to the SPA (default behavior, S3 origin) vs this backend
// (/api/* path pattern, ALB origin) on the same port 443.
const api = express.Router();

// Deliberately outside the JWT-auth chain below — see the comment on
// localDownloadRouter in src/routes/documents.ts for why that's correct
// here (it mirrors a real S3 presigned URL, which also carries no bearer token).
api.use(localDownloadRouter);

// Also outside the auth chain - a lead submitting the marketing site's
// signup form has no account yet, so there is no token to check.
api.use(leadsRouter);

// Every route below requires a verified Auth0 JWT, resolved to an internal
// tenant context (organization/user, or platform-admin) before any handler
// runs — devAuthBypass is a local-only substitute for the JWT check itself
// (see auth/devBypass.ts), resolveTenant runs unmodified either way.
api.use(isDevAuthBypassEnabled() ? devAuthBypass : requireAuth, resolveTenant);

api.use("/admin", adminRouter);
api.use("/users", usersRouter);
api.use("/groups", groupsRouter);
api.use("/matters", mattersRouter);
api.use(documentsRouter);
api.use(tagsRouter);
api.use(askRouter);
api.use("/audit-log", auditLogRouter);

app.use("/api", api);
app.use(handleUploadError(MAX_UPLOAD_BYTES));

const port = Number(process.env.PORT ?? 4520);
app.listen(port, () => {
  console.log(`cloud-backend listening on :${port}`);
  if (isDevAuthBypassEnabled()) {
    console.warn(
      "\n⚠️  DEV_AUTH_BYPASS is ON — every request authenticates as a fixed local dev user, no real login required.\n" +
        "    Never set this outside local development. It has no effect when NODE_ENV=production.\n",
    );
  }
});
