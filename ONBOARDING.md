# EDD Workbench — Project Onboarding

This file exists to move active work on EDD Workbench to a new machine with full context intact. It's a snapshot of *current state*, not a chronological log — read it top to bottom once, then work from the codebase itself.

## What this is

**EDD Workbench**: a cloud-based, multi-tenant, multi-user eDiscovery SPA, inside the `xbundle-platform` monorepo. Built for Nick (nick@xbundle.co.uk). Staging deployment is at `https://collate.xbundle.co.uk`, AWS region `eu-west-2`, single CDK stack `EddWorkbenchStaging` — no production stack exists yet.

A separate **Electron desktop proof-of-concept** lives in this same repo at `proof-of-concept/` (`client`/`electron`/`server` workspaces — `cloud-backend`/`web` inside that folder are an unrelated, abandoned rebuild attempt; ignore those two). It's the design reference this whole rebuild has been matched against feature-by-feature — when in doubt about how something should look or behave, check the POC's real source before guessing.

## Git status

This is now a real git repository, with history and a remote — the earlier "not a git repository" gap has been closed. `origin` points to `https://github.com/xb-developer/edd.git`, and `main` is up to date with it. History currently starts from a single squashed `Initial commit: EDD Workbench eDiscovery SPA` — everything before that point has no finer-grained history, so don't expect `git blame`/`git log` on individual features prior to that commit. Normal git workflow applies from here: commit, branch, and push as usual, and treat `origin/main` as the real safety net when moving machines rather than a manual file copy.

## Repo layout

```
apps/edd-workbench/
  server/    Express API (Auth0 JWT auth, RLS-scoped Postgres queries)
  worker/    SQS consumer — ingest pipeline (extraction, attachment/container expansion) + export pipeline
  client/    Vite + React SPA
packages/
  edd-workbench-core/   Shared: DB pool/RLS session helpers, GUID counter, all format extractors, migrations
  edd-workbench-ui/      Shared React components (MatterDetail, viewers, coding panel, etc.)
infra/edd-workbench/     CDK stack (single stack: EddWorkbenchStaging)
proof-of-concept/        Electron POC — design reference, not part of the build
test-data/               Real eml/msg/pst files Nick supplied for manual verification (not synthetic)
```

## How this project is built — read before writing any code

- **TDD with real local substitutes, never mocks.** Postgres/MinIO/ElasticMQ run via `docker-compose.yml` (in `apps/edd-workbench/`). Every test hits real Postgres, real S3-compatible storage, real SQS-compatible queues — not stubbed interfaces. This is a deliberate, explicit preference, confirmed repeatedly.
- **Vitest passing is necessary, not sufficient.** A real bug shipped once where Vitest's esbuild-based loader silently masked a CJS/ESM interop bug (`@kenjiuno/msgreader`) that broke the real worker process (plain Node ESM) while every Vitest test kept passing. `packages/edd-workbench-core/src/smokeExtractors.ts` exists specifically to catch this class of bug — it runs under plain `tsx`, the same loader production actually uses. Root `npm run test:run` runs both Vitest and this smoke script; run both, not just Vitest.
- **Vet new npm dependencies against the real registry** (`registry.npmjs.org/<pkg>`), not just search-summary text — check publish dates, maintainers, real dependency footprint, and what the package is actually *for* (not just its name). This matters especially for anything parsing untrusted third-party file formats (which is most of this app's ingest pipeline). A maximalist tool is a worse fit than a narrow one even when both are legitimate — flag the tradeoff rather than silently picking the first plausible option.
- **Manual verification is required for anything UI-facing.** No jsdom/testing-library exists in this monorepo, and no browser-automation tool is available in a typical shell session — pure logic gets full Vitest coverage; effectful React hooks/components get a manual browser pass instead. Don't claim a UI feature works without either seeing it in a real browser or getting explicit confirmation from Nick that he has.
- **Diagnostic scripts, not permanent scaffolding.** When you need to prove something end-to-end against real Postgres/S3/SQS outside of Vitest, write a temporary script (`_diag-*.mjs`/`.ts` in the relevant package's `src/`), run it, delete it immediately after. Several real bugs this session were only caught this way.

## Local dev environment — known quirks

- **Dev data is not durable.** The seeded org/matter/documents do not survive between sessions reliably — check `documents`/`organizations` row counts before assuming seed data exists; reseed if empty.
- **The dev S3 bucket and SQS queues are not auto-created** (`edd-workbench-documents-dev`, `edd-workbench-ingest-dev`, `edd-workbench-export-dev`) — only the Vitest suite creates its own `-test`-suffixed resources inline. Create the dev ones by hand against MinIO/ElasticMQ if they're missing.
- **`tsx watch` misses file changes on NTFS-mounted paths.** If dev server/worker/client processes seem to be serving stale code despite correct on-disk changes, kill and restart them — don't debug the code first. This has caused real, confusing false alarms.
- **Docker's `data-root` must live on a native Linux filesystem, not NTFS** — NTFS mounts here report a fixed uid/gid for every file regardless of chown, which silently breaks Postgres's own `initdb` ownership requirements.
- **Migrations run via `MIGRATE_DATABASE_URL`** (the Postgres *owner*/superuser, not the low-privilege `edd_workbench_app` role migrations create) — `npm run migrate:edd-workbench` from repo root for local dev; for the local *test* DB, run `MIGRATE_DATABASE_URL="postgres://postgres:postgres@localhost:5432/edd_workbench_test" npx tsx src/migrate.ts` from `packages/edd-workbench-core`.

## Current feature status (as of this handoff)

Everything below is implemented, tested (real substrates), and typechecked/built clean across all four packages — but **not yet confirmed deployed to staging** (see Deployment section — there's a known recurring gap between "deploy reported as run" and "deploy actually landed").

- **Ingest pipeline**: docx/xlsx/xls/pptx/eml/msg/doc(legacy, sniffed)/rtf/odt/ods/odp/epub/html/csv/tiff(no extractor yet)/PST/OST/Zip. pdf/image/text/other: metadata captured at upload, no content extraction yet (that's the next major phase — see Outstanding Work).
- **Family/parent GUID model** (the trickiest subsystem — read carefully before touching): each document has `guid` (own), `parentGuid` (direct parent, nullable), `familyGuid` (root of its whole family tree, **never** null — a childless document is its own family root), and `depth`. `familyGuid` is **not** "one level up" — it's stored as a real column (`family_document_id`, migration `018`) set once at a family's root and inherited *unchanged* by every descendant regardless of depth. Getting this distinction right matters: at depth 1 the two concepts happen to coincide, which is exactly why an earlier bug (family computed as a naive one-level-up self-join) went unnoticed until a depth-2 case (a PST message's own attachment) exposed it.
- **Transparent containers** (PST/OST, Zip): these get **no document row for the container itself** — each message/member becomes its own document. If the container was a top-level upload, each message becomes its own *independent* family root. If the container arrived nested (e.g. a `.zip` attached to an email), its messages/members become direct children of that real ancestor instead — the container is an invisible pass-through, not a family-severing boundary. The container's row + S3 object are deleted only on **full** success; a partial failure keeps the container row visible with a recorded failure count. This is a deliberate, real reversal of an earlier "keep PST as a real document" decision — matches the Electron POC's actual `mbox`-container treatment.
- **Bulk document selection + bulk coding + custom codes**: checkbox column (independent of the single-document preview selection), select-all in the header, real matter-scoped tag backend (`tag_sets`/`tags`/`document_tags` tables, migrations `013`–`015`), custom code creation via a text box (case-insensitive find-or-create).
- **Export**: two buttons (documents zip / properties CSV), both scoped to the current checkbox selection, real async job pipeline over a pre-provisioned SQS queue (`matter_exports` table, migration `016`) — not a synchronous HTTP response (the ALB's 60s timeout would break that).
- **Document properties panel**: GUID + metadata summary above the preview pane, with "Attached to"/"Family" rows using the parent/family-GUID fields above.
- **Pop-out viewer**: real always-on-top via the Document Picture-in-Picture API (Chrome/Edge 116+), with automatic fallback to a plain `window.open()` pop-out (no always-on-top) on Firefox/Safari.
- **Ingest-processing progress bar**: separate from the upload-progress bar — polls until every uploaded document leaves `pending`/`processing`.
- **Table UX**: filenames indent by `depth` with a `↳` prefix (matches the POC exactly), center panel scrolls internally (was a real CSS bug — the outermost `.app` wrapper had no bounded height at all).
- **Extraction correctness fixes**: inline `cid:`-referenced email images/Outlook-hidden attachments are no longer extracted as child documents (only real attachments are); `.msg` To/From/Cc now resolve the real SMTP address instead of an Exchange Active-Directory display name (a real `email` field can be an unusable X.500 directory string when `addressType` is `'EX'` — the actual address, when resolvable, lives in a separate `smtpAddress` field).

## Deployment

Two-step, always, from `infra/edd-workbench`:
```
npx cdk deploy EddWorkbenchStaging
npm run migrate -- EddWorkbenchStaging
```
`cdk deploy` alone never touches the database — skipping the migrate step after a deploy that adds migrations produces a real internal-server-error on any request that touches the new schema. Current migrations run through `019` (`zip_content_type`).

**Verify a deploy actually landed — don't trust a report that it ran.** Twice in this project's history, "I ran cdk deploy" didn't actually update the live site. The reliable, credential-free check:
```
curl -s https://collate.xbundle.co.uk/ | grep -oE '<script[^>]*src="[^"]+"'
curl -sI https://collate.xbundle.co.uk/assets/<that-hash>.js | grep -i last-modified
```
The `Last-Modified` timestamp on the JS bundle is real, independent proof of *when* it was actually uploaded — a changed hash alone isn't quite enough to trust blindly. The same category of technique (checking real HTTP behavior with no credentials needed) also works for confirming the S3 bucket's CORS configuration is live: send an unauthenticated `OPTIONS` preflight straight to `https://edd-workbench-<env>-documents.s3.eu-west-2.amazonaws.com/<any-key>` with an `Origin` header — S3 evaluates CORS before checking auth.

**A known environment gap** (may or may not apply on the new machine): the shell used for this work had no `docker` group membership and no AWS CLI/credentials, so `cdk deploy` and the migrate step always had to be run by Nick directly, never by the assistant. Check `docker ps` and `aws sts get-caller-identity` (or equivalent) on the new machine before assuming this constraint still holds.

## Outstanding work

- **WS1 Phase 2** (paused, needs explicit go-ahead before starting): PDF text extraction + OCR, image OCR, TIFF OCR. Needs a new SQS queue and a separate Fargate OCR service so a slow scanned-PDF job can't block fast eml/docx ingestion sitting behind it in the same queue. Explicitly not started — flagged, not forgotten.
- **Manual browser verification still needed** for everything in the "Current feature status" list above marked as built-but-unconfirmed-deployed — particularly: the PiP always-on-top behavior in a real Chromium browser (and specifically a `.pptx` document opened while floating — flagged as the one real risk, since that viewer's rendering library touches the ambient `document`, not necessarily the portaled one), the depth-based filename indentation, and a real end-to-end PST/Zip upload through the actual UI (already verified via direct worker-level diagnostic scripts against real files in `test-data/`, but not yet through the browser).
- No production AWS stack exists yet — only staging.

## If you're a fresh Claude Code session picking this up

Read `packages/edd-workbench-core/src/migrations/` in filename order to see the real current schema — it's the ground truth over any prose description here. Check `apps/edd-workbench/worker/src/handlers/ingest.ts` before touching anything ingest-related; it's dense but the comments explain *why*, not just *what*, for every non-obvious decision (transaction-per-item granularity, transparent-container pass-through, size ceilings). Ask Nick before running any destructive or production-affecting command, and before assuming a "deploy done" report without independently checking the `Last-Modified` header trick above.
