# Collate (EDD Workbench)

A cloud-based, multi-tenant eDiscovery review tool: reviewers ingest documents into a matter, review them, apply tags, and export a tagged production set.

## Structure

- `client/` — the browser SPA
- `server/` — the API
- `worker/` — background document ingestion/extraction
- `ocr-service/` — OCR processing
- [`../../packages/edd-workbench-core`](../../packages/edd-workbench-core) — shared server/worker code (extractors, DB access, migrations)
- [`../../packages/edd-workbench-ui`](../../packages/edd-workbench-ui) — shared React components

See [`CONTEXT.md`](./CONTEXT.md) for the project's domain terminology.

## Third-party notices

See [`NOTICE.md`](./client/public/NOTICE.md) for open-source software acknowledgements and copyright information — also shown in-app via the "Notices" button in the top ribbon.
