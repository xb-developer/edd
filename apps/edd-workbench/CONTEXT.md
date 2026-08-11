# EDD Workbench

A cloud-based, multi-tenant eDiscovery review tool: reviewers ingest documents into a matter, review them, apply tags, and export a tagged production set.

## Language

**Matter**:
A single case/engagement a tenant organization is working — the top-level container documents belong to.

**Document**:
A single ingested file within a matter, identified by its sequential GUID, with extracted metadata and a review status.

**GUID**:
The sequential, zero-padded, Bates-style number assigned to a document within a matter at upload time (e.g. `000001`) — not a random/UUID identifier, despite the name.
_Avoid_: Bates number (used in the wider industry, but this codebase's tables/code consistently say GUID)

**Coding**:
The act of applying a review decision or tag to a document. Distinct from *editing* — coding never changes a document's content, only its review metadata.
_Avoid_: Tagging (used loosely in conversation, but "coding" is the precise term once decisions/status are involved, not just labels)

**Tag set**:
A named, tenant-defined group of related tags a reviewer can apply while coding a document (e.g. "Privilege", "Responsive", "Hot Doc").

**Ingest**:
The asynchronous pipeline that downloads an uploaded document from S3, extracts its metadata, and marks it ready (or failed) — runs in the worker, off the request path.
