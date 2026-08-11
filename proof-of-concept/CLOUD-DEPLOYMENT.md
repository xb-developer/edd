# EDD Workbench — Cloud Deployment

How to take what's in `cloud-backend/` + `web/` and get it running on AWS.

**This is not the desktop app.** `server/` and `client/` (the Electron/SQLite
single-user tool) are a separate product and are never part of this
pipeline — see the note at the end if that's what you actually need.

**Nothing here has been run today.** This document describes the deploy
path for whatever is currently in `cloud-backend`/`web` — as of today that
includes the audit trail, expanded text extraction (Word/Excel/PowerPoint/
email), and the 5GB upload limit — but no deploy has actually happened
against AWS. Test locally first (Step 0) before touching anything below it.

## Status snapshot — read this before doing anything else

- **AWS access has been blocked since 2026-07-31** for the IAM user
  (`Robert`) this pipeline runs under. Nothing past Step 0 is possible
  until that's restored — confirm access works (`aws sts get-caller-identity`)
  before attempting any step that touches AWS.
- **The SPA's TLS certificate (`stage.xbundle.com`) expires 2026-08-14.**
  It's an imported cert, not ACM-managed, so it does **not** auto-renew. A
  new cert needs importing into ACM (`us-east-1`, CloudFront requires that
  region) and `spa_acm_certificate_arn` in `terraform.tfvars` updated,
  independently of whether an app deploy happens at all.
- The last known-good `terraform.tfvars` already has real values wired
  (AWS account `901407941726`, region `eu-west-2`, real Auth0 tenant) — see
  `infra/environments/dev/terraform.tfvars`. Nothing there needs to change
  for today's app-code updates; no new infrastructure or environment
  variables were introduced.
- **No new database migration.** `audit_log` already existed in
  `001_init.sql`; today's work only added code that writes to a table that
  was already there. `migrations/005_leads.sql` is still the newest file.

## Architecture at a glance

| Piece | Where | Runs as |
|---|---|---|
| API | `cloud-backend/src/index.ts` | ECS Fargate service `edd-dev-api` |
| Worker (extraction/embedding) | `cloud-backend/src/worker.ts` | ECS Fargate service `edd-dev-worker` |
| Database | Postgres, RLS-enforced | RDS (`module.database`) |
| Document storage | S3 | `module.storage` repository bucket |
| RAG/LLM | Ollama, self-hosted | GPU EC2 (`module.rag`, `g4dn.xlarge` — left running costs money even when idle) |
| SPA | `web/` (Vite/React) | S3 + CloudFront (`module.cdn`) |
| API ingress | — | CloudFront `/api/*` → ALB → ECS (not a direct ALB endpoint) |

## Prerequisites

- AWS CLI configured with working credentials for account `901407941726`
  (`aws sts get-caller-identity` succeeds).
- Docker is **not** required locally — images are built inside CodeBuild.
  You do need `zip`/`aws s3 cp` locally to ship source there (there's no git
  remote for this project; CodeBuild reads a zipped source snapshot from S3,
  see `infra/modules/cicd/source.tf`).
- Terraform ≥ the version already used in `infra/` (check
  `terraform version` against any `.terraform-version` if present).
- Node 22, to run the local verification in Step 0.

## Step 0 — verify locally first (do this before anything below)

This is the check the user asked for explicitly — confirm the current code
actually works before it goes anywhere near AWS.

```bash
cd cloud-backend
npm run build                                    # tsc — must be clean
node --import tsx --test test/isolation.test.ts test/pipeline.test.ts \
  test/collaboration.test.ts test/audit-log.test.ts test/extract-formats.test.ts \
  test/upload-error.test.ts                      # needs local Postgres running
```

`test/rag-isolation.test.ts` is deliberately excluded above — it needs a
local Ollama running (`http://localhost:11434`); include it if you have that
running locally too. All of the above should pass before proceeding.

## Step 1 — build and push the container images

No git push triggers this — the source has to be zipped and uploaded by hand
each time:

```bash
cd "EDD Platform"
zip -r source.zip package.json package-lock.json cloud-backend tsconfig.json -x '*/node_modules/*' '*/dist/*'
aws s3 cp source.zip s3://edd-dev-build-source/source.zip
aws codebuild start-build --project-name edd-dev-build
aws codebuild batch-get-builds --ids <build-id-from-above>   # poll until SUCCEEDED
```

This builds **both** Dockerfile targets (`api` and `worker` — one
`Dockerfile`, two targets, see `cloud-backend/Dockerfile`) and pushes both
to ECR as `:latest`. Watch the build logs in CloudWatch
(`/codebuild/edd-dev-build`) rather than assuming success.

**Only `:latest` is ever pushed — there's no versioned tag.** If a bad image
goes out, there's no `docker tag` to roll back to; the only way back is
re-running a build from an earlier `source.zip` you happen to still have.
Worth fixing before this matters for a real pilot, not fixed here.

**Something genuinely new this deploy needs to work:** `cloud-backend`'s
`xlsx` dependency resolves to a direct HTTPS tarball
(`cdn.sheetjs.com`), not the npm registry — confirm CodeBuild's network
egress can actually reach that host. It's a public CDN with no auth, so this
should just work, but it's the one new external dependency in this build
that wasn't there for the last successful deploy.

## Step 2 — apply the Terraform (only if something in `infra/` actually changed)

Nothing in `infra/` changed today — this step only matters if you're also
picking up infra changes, or this is the first apply. See `infra/README.md`
for the full module breakdown and what's aspirational vs wired. In short:

```bash
cd infra/environments/dev
terraform init
terraform plan     # review carefully — nothing has run this against a real
                    # account recently given the access blocker above
terraform apply
```

## Step 3 — run the database migration

Idempotent and safe to run every deploy regardless of whether anything
changed (`cloud-backend/src/db/migrate.ts` tracks applied files in a
`schema_migrations` table and skips what's already applied):

```bash
aws ecs run-task \
  --cluster edd-dev-cluster \
  --task-definition edd-dev-api \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-id>],securityGroups=[<api-sg-id>],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/db/migrate.js"]}]}'
```

Pull the actual subnet/security-group IDs from `terraform output` in
`infra/environments/dev` rather than hardcoding them here — they're not
stable across environments.

## Step 4 — roll the ECS services onto the new image

`:latest` doesn't auto-deploy just because a new image was pushed — ECS
needs telling to redeploy:

```bash
aws ecs update-service --cluster edd-dev-cluster --service edd-dev-api --force-new-deployment
aws ecs update-service --cluster edd-dev-cluster --service edd-dev-worker --force-new-deployment
```

Watch `aws ecs describe-services` for the new deployment reaching
`PRIMARY`/steady state, and check `/ecs/edd-dev-api` and `/ecs/edd-dev-worker`
CloudWatch logs for startup errors before assuming it worked — the ALB
health check (`/health`) only tells you the process is up, not that it's
actually working end to end.

## Step 5 — build and deploy the SPA

```bash
cd web
npm run build                        # outputs to web/dist
aws s3 sync dist/ s3://<spa-bucket-name> --delete
aws cloudfront create-invalidation --distribution-id <spa-distribution-id> --paths "/*"
```

Get `<spa-bucket-name>` and `<spa-distribution-id>` from `terraform output`
(`module.cdn.spa_bucket_name` / `spa_distribution_id` in
`infra/environments/dev/outputs.tf` — add those as root outputs if they
aren't already exposed there). `web/.env.example` shows what
`VITE_CLOUD_API_BASE_URL`/`VITE_AUTH0_*` need to be for the build.

## Step 6 — verify the actual deploy, not just that it started

- `curl https://<alb-dns>/health` — direct ALB, bypasses CloudFront.
- Log into the real SPA URL, create/open a matter, upload one small file of
  each newly-extractable type (a `.docx`, `.xlsx`, `.pptx`, `.eml`) and
  confirm each reaches `status: extracted` with real text, not
  `extraction_failed`.
- Deliberately trigger a denial (try an action you know you're not
  authorised for) and confirm it shows up in `GET /api/audit-log` as
  `allowed: false` — this is the one feature today that's easy to think
  works from the code alone without ever having produced a real row.
- Upload something a few hundred MB to sanity-check the raised limit
  actually holds in the real environment — see the risk note below before
  trying anything close to 5GB.

## Known risks this deploy carries (not fixed, flagged)

- **API task memory (1024 MiB, `infra/environments/dev/main.tf`) vs. a
  5GB upload limit.** Uploads are fully buffered in the API process before
  being written to S3 (`multer.memoryStorage()`,
  `cloud-backend/src/documents/uploadDocument.ts`) — a multi-GB upload
  against a 1GB task is a real OOM risk, not a hypothetical one. The 5GB
  ceiling was set deliberately (matches the per-matter storage plan), with
  the understanding that very large uploads may fail and need retrying —
  see the warning already added to the SPA's uploader. If large uploads
  become routine rather than occasional, task memory needs raising or the
  upload path needs to move to direct-to-S3 presigned uploads.
- **CloudFront's own request-body size limit is still unverified against
  current AWS documentation.** The API sits behind CloudFront
  (`infra/modules/cdn/spa.tf`'s `/api/*` behavior), not a direct ALB
  endpoint — a large upload could be rejected by CloudFront before it ever
  reaches the app, independently of the app-level limit. Confirmed
  separately, and not the same thing: the WAF's `SizeRestrictions_BODY`
  rule *is* already handled — it's deliberately set to `count` rather than
  `block` in `infra/modules/compute/alb.tf`, specifically because its 8KB
  default would otherwise have silently blocked nearly every real upload.
- **Container formats (.zip/.pst/.ost/.mbox) still aren't expanded** in
  `cloud-backend` — they upload fine and are stored, but nothing inside
  them is extracted. Confirmed still out of scope per the last conversation
  on this.
- **No stale-job reaper.** A job that crashes mid-processing sits in
  `processing` forever (flagged since Phase 2, still true).

## If you actually meant the desktop app

Nothing above applies. The Electron app (`server`/`client`) has no cloud
deployment step at all — it's `npm run dev` (or the packaged installer) run
directly on the user's own machine, no AWS involved. See
`Start Alpha Test.bat` if you meant the local alpha of *this* cloud app
running entirely on your own machine instead (mock payment, real Auth0,
no AWS) — that's a third thing, distinct from both a real cloud deploy and
the desktop app.
