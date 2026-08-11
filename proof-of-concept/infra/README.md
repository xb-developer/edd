# EDD Workbench — Infrastructure (Terraform)

Terraform for the AWS reference topology described in the deployment
strategy doc's Section 8, built as the buildable subset of Phase 5
("Pilot and hardening") — see `cloud-backend/` for the application code
this deploys, and the memory notes on this project for how Phase 5 got
scoped down to just this.

## Structure

```
infra/
  modules/
    network/    VPC, public/private subnets, NAT, routing
    security/   Security groups (ALB, API, workers, RDS, RAG)
    database/   RDS PostgreSQL Multi-AZ + its Secrets Manager entry
    storage/    Secure Document Repository (S3) + SPA hosting (S3+CloudFront)
    compute/    ECS Fargate (API + worker services), ALB, WAF, autoscaling
  environments/
    dev/        Root module wiring all of the above together
```

One module set, parameterised per environment (Section 10.2) — `dev/` is
the only environment wired up so far; `staging/` and `production/` would be
copies of `dev/`'s three files (`main.tf`, `variables.tf`, `outputs.tf`)
with different `terraform.tfvars` (`multi_az = true`,
`deletion_protection = true`, bigger instance sizes).

## What's actually wired to the app you can run today

Everything below matches a real environment variable or behavior in
`cloud-backend/` as it exists right now:

| Terraform resource | Matches |
|---|---|
| `module.database` (RDS Postgres) | `DATABASE_URL` — same schema as your local dev Postgres (`cloud-backend/migrations/`) |
| `module.storage` repository bucket | `DOCUMENT_STORE=s3`, `S3_BUCKET`, `AWS_REGION` — `cloud-backend/src/storage/s3Store.ts` |
| `module.compute` API/worker ECS services | `cloud-backend/src/index.ts` and `cloud-backend/src/worker.ts` as the two container entrypoints |
| ALB health check on `/health` | `cloud-backend/src/index.ts`'s health route |
| Secrets Manager → ECS `secrets` block | how `DATABASE_URL` and `AUTH0_MGMT_CLIENT_SECRET` reach the containers, never as plain env vars |
| KMS key on RDS + S3 | Section 7.2 |

## What's declared here as target architecture but NOT yet consumed by the app

Being upfront about this gap matters more than looking complete:

- **SQS is not provisioned at all.** Section 8.1 calls for it, but
  `cloud-backend`'s worker currently polls a Postgres `jobs` table directly
  (`FOR UPDATE SKIP LOCKED`) — a deliberate Phase 2 simplification, not an
  oversight (see the cloud-backend project memory). Provisioning an SQS
  queue nothing reads from would just be a cost with no function. The
  worker's CPU-based autoscaling policy is a stand-in for true queue-depth
  scaling until either a custom CloudWatch metric is added or a real SQS
  migration happens.
- **No GPU compute for the RAG/LLM service.** `OLLAMA_BASE_URL` is a
  required variable with no default — Section 14 explicitly flags
  "third-party LLM provider vs. self-hosted model" as an open decision
  needing sign-off, and this plan doesn't pre-empt that by silently standing
  up (and billing for) a `g5` instance. Point the variable at wherever
  Ollama (or whatever's chosen) actually runs once that decision is made.
- **No Route 53 / ACM.** No real domain name exists yet to provision either
  against. `acm_certificate_arn` defaults to `null` and the ALB serves
  plain HTTP in the meantime — swap it in once a domain exists.
- **Only one shared KMS key**, not true per-tenant keys. Per-tenant
  encryption (Section 7.2) is created dynamically by the Backend via the AWS
  SDK as each firm onboards — the number of tenants isn't known at
  `terraform apply` time, so it can't be a static Terraform resource.
- **Remote state backend is commented out.** The S3 bucket + DynamoDB table
  it needs (Section 10.2) don't exist yet; bootstrapping them is a one-time
  `terraform apply` with local state, done once, before switching the
  `backend "s3"` block on.
- **No CI/CD pipeline.** `api_image`/`worker_image` are plain variables —
  something else (Section 9) has to actually build and push those images.

## Using this

```bash
cd infra/environments/dev
terraform init
cp terraform.tfvars.example terraform.tfvars   # fill in real values; this file is gitignored
terraform plan
terraform apply
```

**What's actually been verified in this environment:** `terraform validate`
passes for every module individually and for the fully-wired `dev` root
module, and `terraform fmt -recursive` has been applied throughout. What
has **not** been run: `terraform plan`/`apply` against a real AWS account —
there isn't one available here. Treat this as syntactically and
referentially correct, structurally sound Terraform that has not yet been
proven against real AWS APIs. Run a real `plan` (and review it carefully)
before the first `apply` anywhere that matters.

## Known follow-ups (tracked, not hidden)

- Stale-job reaper for the Postgres queue (flagged since cloud-backend
  Phase 2 — a job that crashes mid-processing sits in `processing` forever).
- Load-testing "at scale" per Phase 3/Section 12 — nothing here has been
  sized against real pilot volume; the small default instance sizes and
  worker counts are explicitly placeholders, not sizing decisions.
- The deployment doc's Section 14 open decisions (large/bulk upload
  reliability on thin-client networks, extraction worker cost scaling,
  UK/GDPR data residency, third-party vs. self-hosted LLM, malware/AV
  scanning coverage) are still unresolved — this infrastructure doesn't
  settle any of them on its own.
