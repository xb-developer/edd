import { withTenantContext, type TenantContext } from "../db/pool.js";
import { documentKey, getDocumentStore } from "../storage/index.js";

export interface UploadFile {
  originalname: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
}

export interface UploadedDocument {
  id: string;
  guid: string;
  filename: string;
  status: string;
  created_at: string;
}

export class MatterNotFoundOrNoAccess extends Error {
  constructor() {
    super("not_found_or_no_access");
  }
}

/**
 * The actual upload flow (Section 2.2/3.3): allocate the matter's next
 * sequential GUID, insert the document row + extraction job, then write the
 * raw bytes into the Secure Document Repository. Pulled out of the route
 * handler so the pipeline test exercises this exact code, not a
 * reimplementation of it.
 */
export async function uploadDocument(
  tenant: TenantContext,
  matterId: string,
  file: UploadFile,
): Promise<UploadedDocument> {
  const seeded = await withTenantContext(tenant, async (client) => {
    // Bumping next_seq re-validates access via matters_update RLS (group
    // member or platform admin) — zero rows affected means no access.
    const bumped = await client.query(
      "UPDATE matters SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq - 1 AS allocated_seq, group_id, organization_id",
      [matterId],
    );
    if (bumped.rowCount === 0) {
      throw new MatterNotFoundOrNoAccess();
    }
    const { allocated_seq, group_id, organization_id } = bumped.rows[0];
    const guid = String(allocated_seq).padStart(6, "0");
    const storageKey = documentKey(organization_id, matterId, guid, file.originalname);

    const docRow = await client.query(
      `INSERT INTO documents
         (organization_id, matter_id, group_id, guid, filename, storage_key, content_type, size_bytes, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, guid, filename, status, created_at`,
      [organization_id, matterId, group_id, guid, file.originalname, storageKey, file.mimetype, file.size, tenant.userId],
    );
    const document = docRow.rows[0] as UploadedDocument;

    await client.query("INSERT INTO jobs (type, document_id) VALUES ('extract', $1)", [document.id]);

    return { document, storageKey };
  });

  try {
    await getDocumentStore().put(seeded.storageKey, file.buffer);
  } catch (storageErr) {
    // Fail fast and visibly rather than leaving a job that can only ever
    // fail later against a key with no data behind it.
    await withTenantContext(tenant, async (client) => {
      await client.query("UPDATE documents SET status = 'extraction_failed', extraction_error = $2 WHERE id = $1", [
        seeded.document.id,
        `storage write failed: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
      ]);
    });
    throw storageErr;
  }

  return seeded.document;
}
