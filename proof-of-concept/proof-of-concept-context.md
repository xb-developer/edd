# EDD Workbench — Desktop (Electron) App Onboarding

Scope of this document: **only** the local, single-user Electron desktop app. There is a separate, unrelated cloud SaaS rebuild (`cloud-backend/` + `web/`) living in the same monorepo — ignore those folders entirely, they are a different product with different code, different data model, and no shared runtime.

Project root: `C:\Users\MarkAgombar-XBundle\Claude\EDD Platform`. No git repo exists — there is nothing to `git clone`; this is plain files on disk. Owner: Mark Agombar, XBundle Ltd. Last updated: 2026-08-09.

## What it is

A local, single-user eDisclosure/eDiscovery document review tool: import documents into a matter, get them GUID-numbered and text-extracted automatically, tag/code them as a team member would, search across everything (Boolean full-text and natural-language AI Q&A), and export by GUID. Runs entirely on one machine — no server, no login, no cloud dependency except an optional local Ollama install for the AI feature.

## Process architecture

Three workspaces under the monorepo root, glued together by Electron:

```
EDD Platform/
  electron/         Electron main process (bootstrap.cjs, main.ts, preload.cjs)
  server/           Local Express API - the actual application logic
  client/           React/Vite renderer - the UI Electron displays
  (cloud-backend/, web/  <- unrelated cloud product, ignore)
```

- **`electron/main.ts`** launches an Express server (from `server/`) as an in-process HTTP API and opens a BrowserWindow pointed at the built `client/` UI. `requestSingleInstanceLock()` is used so only one copy of the app (and therefore one process touching the local database) can run at a time.
- **`server/`** is a normal Node/Express app (`src/index.ts`), not Electron-specific — it could run standalone with `npm run dev --workspace server` and be hit with curl. Electron just runs it as a child process/embedded server instead of a separate deployment.
- **`client/`** is a plain Vite + React SPA (`src/main.tsx` → `App.tsx`) that talks to the local server over HTTP (`src/api.ts`), same shape as any web frontend — it has no direct Node/Electron API access itself (preload.cjs is minimal).

Dev run: `npm run dev` at the root uses `concurrently` to start the server (port 4420), the Vite client (port 5183), waits for both (`wait-on`), then launches Electron pointed at them. Build: `npm run build:server` / `build:client` compile each workspace; the packaged app presumably loads the built client output rather than a dev server (check `electron/main.ts` for the production vs dev URL branch).

## Data model and storage

No database server of any kind — everything is local files under `%AppData%\EDD Workbench\` (Windows `AppData\Roaming`):

- **`matters.json`** — a flat JSON catalog of every matter created: `{id, name, path, createdAt}`, plus which matter was last open. Read/mutated synchronously as one unit (`server/src/db.ts`) — safe within a single process, and cross-process races are prevented by Electron's single-instance lock, not by file locking.
- **`matters/<slug>/`** — one folder per matter (slug = matter name + a short random suffix), each fully self-contained: its own SQLite file and its own imported-files folder. Matters do not share any data or GUID sequence — switching matters in the UI just points the running server at a different folder.
- Each matter's **SQLite database** (`node:sqlite`, Node's built-in driver — no native module/build step) holds:
  - `documents` — one row per imported document/family member, including `family_id`, `parent_guid`, `depth` for zip/email-attachment nesting.
  - `tags`, `document_tags` — the tag vocabulary and per-document tag assignments.
  - `counters` — the matter's own sequential GUID counter.
  - `documents_fts` — an **FTS5 virtual table** for Boolean full-text search (Node's built-in `node:sqlite` supports FTS5 directly — confirmed working, no extra search engine needed).
  - `chunks`, `embedding_queue` — text chunks and their embeddings for the AI Q&A feature, plus a queue so embedding happens asynchronously after import rather than blocking it.

## Everything the app does, and where the code is

| Feature | Where |
|---|---|
| Matter create/list/switch, per-matter isolation | `server/src/db.ts`, `server/src/routes/matters.ts`, `client/src/components/MatterPicker.tsx` |
| Import + sequential GUID allocation | `server/src/routes/documents.ts` |
| Metadata + text extraction (format registry) | `server/src/lib/metadata.ts` — one function per format family, dispatched by extension |
| Zip / email-attachment / mbox expansion into child documents, contiguous family GUID numbering | `server/src/lib/familyExtract.ts` |
| PST/OST mailbox expansion | `server/src/lib/pstExtract.ts` (via `pst-extractor`) |
| Legacy binary `.ppt` best-effort text | `server/src/lib/legacyPpt.ts` |
| `.pptx` text extraction | `server/src/lib/pptxText.ts` |
| `.msg` parsing (Outlook) | `server/src/lib/msgReader.ts` (wraps `@kenjiuno/msgreader`, with a documented ESM/CJS interop workaround — see the comment in that file before touching it) |
| OCR (scanned images) | `server/src/lib/ocr.ts` |
| OCR retry for scanned PDFs with no text layer | `server/src/lib/pdfOcr.ts` |
| Format sniffing (e.g. a `.doc` that's actually RTF or a renamed `.docx`) | `server/src/lib/textSniff.ts` |
| Parallel import (discover) / serial (commit) via a worker pool | `server/src/lib/extractPool.ts`, `server/src/workers/extract-worker.ts` (Piscina-based) |
| Document content/preview API | `server/src/routes/content.ts` |
| Tag definitions + apply/remove | `server/src/routes/tags.ts`, `client/src/components/CodingPanel.tsx`, `FilterPanel.tsx` |
| Export (zip by GUID + metadata CSV) | `server/src/routes/export.ts`, `server/src/lib/csv.ts` |
| Boolean full-text search | FTS5 table above, queried from `server/src/routes/documents.ts` |
| AI "Ask" (RAG: chunk → embed → retrieve → grounded answer with citations) | `server/src/lib/chunk.ts`, `server/src/lib/ollama.ts`, `server/src/lib/embeddingWorker.ts`, `server/src/routes/ask.ts`, `client/src/components/AskPanel.tsx` |
| Results table / register UI | `client/src/Register.tsx`, `components/ResultsTable.tsx` |
| Document viewer (separate window) | `client/src/ViewerWindow.tsx`, `components/PreviewPane.tsx` |

## Dependencies, and why each is there (`server/package.json`)

Format/extraction libraries — this is the bulk of the app's real complexity:

- **`mammoth`** — `.docx` text extraction.
- **`xlsx`** (installed from `cdn.sheetjs.com`, **not** the npm registry package — the npm one has a known unpatched vulnerability; this is the deliberate fix) — `.xlsx`/legacy `.xls` reading.
- **`officeparser`** — covers `.odt`/`.ods`/`.odp`/`.pdf`/`.html`/`.rtf`/`.csv`/`.md`/`.epub` in one library, including its own OCR integration (pulls in `tesseract.js` transitively — that's why `tesseract.js` isn't a direct dependency but does need an `allowScripts` entry at the repo root).
- **`word-extractor`** — legacy binary `.doc` (OLE2) text.
- **`mailparser`** — `.eml` parsing.
- **`@kenjiuno/msgreader`** — Outlook `.msg` parsing.
- **`pst-extractor`** — PST/OST mailbox expansion.
- **`cfb`** — low-level Compound File Binary reader, used by the legacy-format libraries above.
- **`jszip`** — zip archive expansion (also used to read OOXML container internals like `docProps/core.xml` for metadata).
- **`archiver`** — zip creation, for export.
- **`fast-xml-parser`** — reading OOXML metadata XML (`docProps/core.xml` etc.).
- **`pdfjs-dist`** — PDF text-layer extraction (the "legacy" Node build, no DOM/canvas dependency needed for text).
- **`@napi-rs/canvas`** — prebuilt-binary canvas implementation, used to rasterize scanned PDF pages before OCR (no local C++ build toolchain needed, which matters on a machine with no Visual Studio Build Tools).
- **`utif2`** — TIFF image decoding for OCR input.
- **`ppt`** — legacy `.ppt` best-effort reading.
- **`nodemailer`** — used for constructing/parsing email-shaped content (supporting role to the `.eml` pipeline).

Infrastructure:

- **`piscina`** — worker-thread pool for parallel import/extraction, so importing many files doesn't block the main server thread.
- **`express`**, **`cors`** — the local HTTP API itself.
- **`undici`** — HTTP client, used for the Ollama API calls.

Client (`client/package.json`) is deliberately minimal: **`react`**, **`react-dom`**, built with **`vite`**. No UI component library, no state management library, no router — plain React state, matching a small, self-contained app.

Root (`package.json`): **`electron`** (the shell itself), **`concurrently`** + **`wait-on`** (dev-mode process orchestration only, not part of the shipped app), **`typescript`**.

AI/RAG stack: **Ollama**, running locally and separately (not an npm dependency — it's an external program the app calls over HTTP via `undici`). Embedding model `nomic-embed-text`, generation model in the `llama3.1:8b` class. If Ollama isn't installed/running, every feature except AI Q&A still works.

## Building and running

```bash
npm install          # from the repo root - installs all four workspaces
npm run dev           # starts server + client + Electron together, for development
npm run build:server   # compiles server/ (tsc)
npm run build:client   # compiles + bundles client/ (tsc -b && vite build)
```

No packaged installer command is listed in the root `package.json` scripts as of this writing — if one exists it was likely run ad hoc (e.g. `electron-builder`/`electron-forge` invoked directly rather than wired into `npm run`); check for a separate config file (`electron-builder.yml`, `forge.config.js`) before assuming there isn't one.

## Known limitations, stated plainly

- **Legacy `.ppt` (PowerPoint 97-2003)** has no reliable pure-JS text extractor — it registers with filesystem metadata only, explicitly flagged in the UI as unsupported for text, same treatment as `.dwg`.
- **`.dwg`** — genuine CAD parsing needs a paid SDK (Autodesk/ODA/Aspose.CAD); registered with metadata only.
- **`.mpp`** (MS Project) — no viable pure-JS reader without pulling in an LGPL-licensed library; metadata only.
- OCR retry for scanned PDFs is best-effort, not guaranteed — see the comment in `pdfOcr.ts` for the specific heuristic (text-layer length threshold) it uses to decide a page needs rasterizing.
- Everything is single-user/single-machine by construction — there is no multi-user access control, no audit trail, no remote backup. (That's what the separate cloud rebuild exists to eventually replace — but that is out of scope here.)
