import { Router } from "express";
import { stringify } from "csv-stringify/sync";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { requireRole } from "../auth.js";

// Mounted at /api/audit — org-scoped but not matter-scoped, unlike
// everything else that writes an audit row. Logout has no server-side
// event of its own to hook (this app's login/logout is purely client-side
// Auth0 redirect) — the client calls this itself, right before triggering
// the actual Auth0 logout redirect, best-effort (never blocking logout on
// a failure here — see EddWorkbenchWorkspace.tsx's handler).
export const auditRouter = Router();

auditRouter.post("/logout", async (req, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, { orgId, actorUserId: userId, action: "logout", description: "User logged out" }),
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

interface AuditLogRow {
  created_at: Date;
  action: string;
  description: string;
  actor_user_id: string | null;
  matter_id: string | null;
  document_id: string | null;
  details: Record<string, unknown> | null;
}

// The one place this whole table gets read back — everything else in this
// codebase only ever INSERTs into audit_log (see recordAuditEvent). Whole
// org, not paginated: an activity trail at this app's realistic org sizes
// (per-firm, not per-user) is small compared to the document data these
// same reviewers already export in bulk, and a plain CSV download is what
// was actually asked for, not a browsable/paginated log viewer. Admin-only
// — this reveals every user's activity across every matter in the org, a
// materially different sensitivity level than any other read endpoint.
auditRouter.get("/export", requireRole("admin"), async (req, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const rows = await withOrgSession(orgId, (client) =>
      client.query<AuditLogRow>(
        "SELECT created_at, action, description, actor_user_id, matter_id, document_id, details FROM audit_log ORDER BY created_at ASC",
      ),
    );

    const csv = stringify(
      rows.rows.map((row) => ({
        timestamp: row.created_at.toISOString(),
        action: row.action,
        description: row.description,
        actor_user_id: row.actor_user_id ?? "",
        matter_id: row.matter_id ?? "",
        document_id: row.document_id ?? "",
        details: row.details ? JSON.stringify(row.details) : "",
      })),
      { header: true },
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
