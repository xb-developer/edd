import { Router, type Request } from "express";
import { stringify } from "csv-stringify/sync";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { requireRole } from "../auth.js";

// mergeParams — mounted at /api/matters/:matterId/audit, behind
// requireMatterAccess (index.ts), so a denied load attempt never produces a
// false "loaded" record — the client only ever gets here once it's already
// allowed to open the matter.
export const matterAuditRouter = Router({ mergeParams: true });

matterAuditRouter.post("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    await withOrgSession(orgId, async (client) => {
      const matter = await client.query<{ name: string }>("SELECT name FROM matters WHERE id = $1", [matterId]);
      await recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId,
        action: "matter.load",
        description: `Loaded matter "${matter.rows[0]?.name ?? matterId}"`,
      });
    });
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
  document_id: string | null;
  details: Record<string, unknown> | null;
}

// The one place this table gets read back — everything else in this
// codebase only ever INSERTs into audit_log (see recordAuditEvent).
// Scoped to THIS matter only (matter_id = $2), not the whole org — a
// reviewer with access to one matter must never see another matter's
// activity trail just because they're in the same org. Not paginated: an
// activity trail for one matter is small compared to the document data
// these same reviewers already export in bulk. Admin-only — this reveals
// every user's activity on the matter, a materially different sensitivity
// level than any other read endpoint.
matterAuditRouter.get("/export", requireRole("admin"), async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;
    const rows = await withOrgSession(orgId, (client) =>
      client.query<AuditLogRow>(
        "SELECT created_at, action, description, actor_user_id, document_id, details FROM audit_log WHERE matter_id = $1 ORDER BY created_at ASC",
        [matterId],
      ),
    );

    const csv = stringify(
      rows.rows.map((row) => ({
        timestamp: row.created_at.toISOString(),
        action: row.action,
        description: row.description,
        actor_user_id: row.actor_user_id ?? "",
        document_id: row.document_id ?? "",
        details: row.details ? JSON.stringify(row.details) : "",
      })),
      { header: true },
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${matterId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
