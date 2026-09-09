import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as scheduler from "aws-cdk-lib/aws-scheduler";

export interface EddWorkbenchStackProps extends cdk.StackProps {
  /** e.g. "staging", "prod" — used in resource names (S3 buckets, queues). */
  environmentName: string;
  /**
   * Optional custom domain for the CloudFront distribution — omit to keep
   * using the default *.cloudfront.net domain. certificateArn must be an
   * ACM certificate in us-east-1 regardless of the stack's own region;
   * CloudFront only ever reads certificates from that region. Account-
   * specific, so it's a prop from bin/edd-workbench.ts rather than a
   * literal in this file, matching how `env: { region }` is handled there.
   */
  customDomain?: { domainName: string; certificateArn: string };
}

/**
 * Single-stack MVP topology matching the build plan §1: one S3 bucket for
 * documents + one for the SPA (not bucket-per-tenant), RDS Postgres
 * Multi-AZ with encryption enabled at creation, one ECS cluster with two
 * Fargate services (api behind an ALB, worker consuming two SQS queues),
 * and one CloudFront distribution fronting both the SPA and the API so the
 * browser never crosses an origin (no CORS, matters once Auth0 bearer
 * tokens are involved).
 *
 * This is reviewable infrastructure-as-code, not a deployed environment —
 * splitting into per-concern stacks (network/data/compute/edge) is a
 * reasonable refinement once this needs multiple environments, not needed
 * for a first MVP deploy.
 */
export class EddWorkbenchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EddWorkbenchStackProps) {
    super(scope, id, props);

    const { environmentName, customDomain } = props;

    // --- Networking --------------------------------------------------
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // single NAT for MVP cost; two for prod HA is a fast-follow, not a correctness requirement
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    // Free — a Gateway endpoint has no hourly/data charge of its own, unlike
    // an Interface endpoint. Every document upload/download/OCR/export read
    // or write to DocumentsBucket was previously routed out through the NAT
    // Gateway and billed at $0.05/GB there; a real cost-audit (2026-09-04)
    // found NAT data-processing charges far larger than the NAT Gateway's
    // own flat hourly fee, with S3 traffic as the overwhelmingly likely
    // cause given this app's I/O pattern. Route table entries for S3 are
    // added automatically to every subnet in the VPC's private/isolated
    // subnet groups.
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // --- Encryption ----------------------------------------------------
    // One CMK per environment for MVP (build plan §1) — per-tenant CMKs are
    // a genuine fast-follow, not needed to ship.
    const documentsKey = new kms.Key(this, "DocumentsKey", {
      description: "CMK for EDD Workbench document storage (S3 SSE-KMS)",
      enableKeyRotation: true,
    });

    // --- Storage -------------------------------------------------------
    const documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: `edd-workbench-${environmentName}-documents`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: documentsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      // Client documents outlive the stack that provisioned their bucket —
      // never auto-delete on stack teardown.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // The CloudFront-fronts-both-SPA-and-API design above avoids CORS for
      // *those* two origins, but this bucket is never behind that same
      // distribution — every presigned URL the app mints (view-url's GETs,
      // and init-upload's PUTs for the browser upload flow) is a genuine
      // cross-origin request from the SPA straight to S3's own endpoint. A
      // presigned URL's signature proves *authorization*; it does nothing
      // about CORS, which the browser enforces independently. Same origin
      // list as CORS_ALLOWED_ORIGINS below, for the same reason.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [customDomain ? `https://${customDomain.domainName}` : "http://localhost:5283"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // Export artifacts (handlers/export.ts's zips/CSVs) are
          // throwaway derived output, not source-of-record documents like
          // everything else in this bucket — a reviewer re-runs the export
          // whenever they need a fresh one, so there's no reason to keep
          // these around indefinitely the way the originals must be.
          prefix: "exports/",
          expiration: cdk.Duration.days(7),
        },
      ],
    });

    const spaBucket = new s3.Bucket(this, "SpaBucket", {
      bucketName: `edd-workbench-${environmentName}-spa`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Database --------------------------------------------------------
    // This is the RDS *master/owner* user — deliberately never used by the
    // running api/worker services (see appDbSecret below). Postgres exempts
    // a table's owner from its own Row-Level Security policies regardless
    // of FORCE ROW LEVEL SECURITY, so if api/worker connected as this role,
    // every RLS policy in the migrations would be silently bypassed in the
    // deployed environment while still working correctly in local dev — a
    // real gap this stack had until this revision.
    const ownerCredentials = rds.Credentials.fromGeneratedSecret("edd_workbench_owner");
    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      // Single-AZ, deliberately — the live instance has actually been
      // single-AZ since it was created (2026-09-01): RDS accepted the
      // Multi-AZ conversion request but then hit "Insufficient instance
      // capacity for instance type db.t4g.medium in availability zone
      // eu-west-2a" ~23 minutes later and silently left it single-AZ
      // instead (see the instance's own RDS event log, not a guess) — the
      // CreateDBInstance call itself succeeded, so CloudFormation never saw
      // a failure and kept recording MultiAZ:true, a real drift confirmed
      // via `aws cloudformation detect-stack-resource-drift` (still
      // present as of 2026-09-09, unrelated to that week's other infra
      // work). Accepted here rather than retried: this is staging, not
      // production, and the standby doubles the instance-hour cost
      // (~$53/mo more) for automatic failover this environment doesn't
      // need.
      multiAz: false,
      allocatedStorage: 50,
      // Must be true at creation — cannot be toggled on later without a
      // snapshot-restore event (build plan §9).
      storageEncrypted: true,
      credentials: ownerCredentials,
      databaseName: "edd_workbench",
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // The low-privilege Postgres role api/worker actually connect as —
    // migrations create this *role* (004_org_memberships.sql) but never a
    // password for it, since a migration file can't safely embed one. This
    // secret holds the password Secrets Manager thinks it has; the
    // migration task (below) is what actually sets it on the role via
    // packages/edd-workbench-core/src/setAppPassword.ts, keeping the two in
    // sync on every deploy.
    const appDbSecret = new secretsmanager.Secret(this, "AppDbSecret", {
      secretName: `edd-workbench-${environmentName}-app-db`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "edd_workbench_app" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    // --- Async work: SQS + DLQs ------------------------------------------
    const ingestDlq = new sqs.Queue(this, "IngestDlq", { queueName: `edd-workbench-${environmentName}-ingest-dlq` });
    const ingestQueue = new sqs.Queue(this, "IngestQueue", {
      queueName: `edd-workbench-${environmentName}-ingest`,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    });

    const exportDlq = new sqs.Queue(this, "ExportDlq", { queueName: `edd-workbench-${environmentName}-export-dlq` });
    const exportQueue = new sqs.Queue(this, "ExportQueue", {
      queueName: `edd-workbench-${environmentName}-export`,
      // Zip-building a large matter can run long — visibility timeout must
      // outlast the worst realistic single export, not just the average one.
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: exportDlq, maxReceiveCount: 5 },
    });

    // A separate queue/service from ingest, deliberately — the whole point
    // is that a slow OCR job (rasterizing a multi-page scanned pdf, then
    // running it through the native Tesseract engine, can take tens of
    // seconds to a few minutes) must never block the shared ingest queue's
    // fast eml/docx/etc extractors sitting behind it in line. Visibility
    // timeout covers the ocr-service's own worst-case job timeout (~5
    // minutes, see apps/edd-workbench/ocr-service/src/tesseract.ts's
    // OCR_TIMEOUT_MS) with real margin, same "outlast the worst realistic
    // job" reasoning as the export queue above.
    const ocrDlq = new sqs.Queue(this, "OcrDlq", { queueName: `edd-workbench-${environmentName}-ocr-dlq` });
    const ocrQueue = new sqs.Queue(this, "OcrQueue", {
      queueName: `edd-workbench-${environmentName}-ocr`,
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: { queue: ocrDlq, maxReceiveCount: 5 },
    });

    // The embedding service (below) is only warm on a schedule (business
    // hours) — a message that arrives outside that window fails fast
    // (connection refused, no task running) and must be retried until the
    // service comes back, not just a handful of times like every other
    // queue here. 15-minute visibility timeout x maxReceiveCount 50 gives
    // ~12.5 hours of retry runway, covering a single overnight gap in the
    // default schedule; a message arriving right before a weekend can
    // still exhaust into the DLQ before Monday — a known v1 limitation,
    // not a design goal, worth a DLQ redrive/alarm once this is in real use.
    const embeddingDlq = new sqs.Queue(this, "EmbeddingDlq", { queueName: `edd-workbench-${environmentName}-embedding-dlq` });
    const embeddingQueue = new sqs.Queue(this, "EmbeddingQueue", {
      queueName: `edd-workbench-${environmentName}-embedding`,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: embeddingDlq, maxReceiveCount: 50 },
    });

    // Unlike embeddingQueue above, the target service (ElasticsearchService,
    // below) is always on — no business-hours schedule to outlast — so a
    // short visibility timeout and a handful of retries is enough, same
    // "always-up target" reasoning as ocrQueue's own shape.
    const searchIndexDlq = new sqs.Queue(this, "SearchIndexDlq", { queueName: `edd-workbench-${environmentName}-search-index-dlq` });
    const searchIndexQueue = new sqs.Queue(this, "SearchIndexQueue", {
      queueName: `edd-workbench-${environmentName}-search-index`,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: searchIndexDlq, maxReceiveCount: 5 },
    });

    // --- Secrets: Auth0 --------------------------------------------------
    // CDK-provisioned (not a pre-existing out-of-band secret) so `cdk
    // deploy` alone is enough to create it — the placeholder values below
    // must be overwritten post-deploy (`aws secretsmanager put-secret-value`
    // or the console) with the real tenant's issuer URL/audience, which are
    // real per-environment config, not something to hardcode/commit here.
    const auth0Config = new secretsmanager.Secret(this, "Auth0Config", {
      secretName: `edd-workbench-${environmentName}-auth0`,
      secretObjectValue: {
        issuerBaseUrl: cdk.SecretValue.unsafePlainText("REPLACE_ME_POST_DEPLOY"),
        audience: cdk.SecretValue.unsafePlainText("REPLACE_ME_POST_DEPLOY"),
      },
    });

    // Separate from Auth0Config above (JWT validation) — this is a
    // Machine-to-Machine Auth0 Application authorized for the Management
    // API (scopes read:organization_members, read:users), used only to list
    // an organization's real members for the matter-access "candidates"
    // dropdown (see auth0Management.ts). Auth0 is the sole source of truth
    // for org membership here — no local mirror table. Placeholder values
    // below must be overwritten post-deploy once that M2M application is
    // created in the Auth0 dashboard; auth0Management.ts reads its
    // credentials lazily (not at server startup), so a real deploy doesn't
    // crash-loop while this is still a placeholder — only the candidates
    // endpoint itself fails until it's filled in.
    const auth0ManagementConfig = new secretsmanager.Secret(this, "Auth0ManagementConfig", {
      secretName: `edd-workbench-${environmentName}-auth0-management`,
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText("REPLACE_ME_POST_DEPLOY"),
        clientSecret: cdk.SecretValue.unsafePlainText("REPLACE_ME_POST_DEPLOY"),
      },
    });

    // --- Compute: ECS Fargate ---------------------------------------------
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: "edd-workbench" });

    // Passed explicitly, not left to .dockerignore auto-detection — CDK's
    // own local staging copy for a Docker image asset (which runs before
    // `docker build` ever sees a .dockerignore) turned out not to honor the
    // repo-root .dockerignore reliably here: with directory "../.." (the
    // repo root) and cdk.out living inside it at infra/edd-workbench/cdk.out,
    // the staging copy nested a copy of cdk.out inside itself, which then
    // contained another copy of itself, recursively, until `mkdir` hit
    // ENAMETOOLONG. Excluding it explicitly at the fromAsset() call sidesteps
    // whatever's wrong with the auto-detection path entirely.
    // *.pst/*.ost specifically (not the whole __fixtures__ dir — smaller
    // fixtures elsewhere in it are an existing, unrelated question) since
    // packages/edd-workbench-core/src/extractors/__fixtures__ now holds two
    // real PST/OST test fixtures at ~22MB combined (see that dir's own
    // NOTICE.md) — genuinely useful for pst.test.ts/ingest.test.ts, never
    // needed inside a deployed api/worker image.
    const dockerAssetExcludes = ["infra", "node_modules", "**/node_modules", "**/.env", "**/.env.*", "**/*.pst", "**/*.ost"];

    // A literal, not derived from the GpuService construct defined later in
    // this file — Cloud Map private-DNS names are deterministic
    // ({serviceName}.{namespaceName}), so anything needing this URL
    // (the worker's own environment, set above the GPU service's own
    // declaration) doesn't need a forward reference to that construct.
    // Embedding and generation are co-located on the same instance/service
    // (see the GPU service section below) — same host, distinct ports.
    const EMBEDDING_SERVICE_INTERNAL_URL = "http://gpu.edd-workbench.internal:8000";
    // Same reasoning as EMBEDDING_SERVICE_INTERNAL_URL above — a literal
    // Cloud Map DNS name, not a forward reference to the GpuService
    // construct defined later in this file.
    const GENERATION_SERVICE_INTERNAL_URL = "http://gpu.edd-workbench.internal:8001";
    // Same reasoning again — a literal Cloud Map DNS name, not a forward
    // reference to the ElasticsearchService construct defined later in this
    // file. Port 9200 is Elasticsearch's own default HTTP port.
    const ELASTICSEARCH_SERVICE_INTERNAL_URL = "http://search.edd-workbench.internal:9200";

    // Shared by the api service and the migration task below — one image,
    // one Dockerfile, not two separate builds of the same server code.
    const serverImage = ecs.ContainerImage.fromAsset("../..", {
      file: "apps/edd-workbench/server/Dockerfile",
      exclude: dockerAssetExcludes,
    });

    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "ApiService", {
      cluster,
      serviceName: "api",
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
      // Fail a bad deploy in minutes, not the ~3-hour default timeout.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      taskImageOptions: {
        image: serverImage,
        containerPort: 4430,
        environment: {
          EDD_WORKBENCH_SERVER_PORT: "4430",
          // Host/port are RDS-instance-level, not secret — no reason to
          // spend a Secrets Manager read on them.
          DB_HOST: database.instanceEndpoint.hostname,
          DB_PORT: database.instanceEndpoint.port.toString(),
          // documents.ts reads this at module load (fail-fast, not on first
          // request) to enqueue upload-complete messages — missing here
          // crash-loops the whole api service the moment its code actually
          // exercises the ingest pipeline. Passed to the worker already
          // (below); this stack just never carried it to the api service
          // too, undetected until the first deploy of real ingest-pipeline
          // code. Export queue URL included alongside it for the same
          // reason, ahead of whatever future route needs it.
          EDD_WORKBENCH_INGEST_QUEUE_URL: ingestQueue.queueUrl,
          EDD_WORKBENCH_EXPORT_QUEUE_URL: exportQueue.queueUrl,
          // The app is same-origin behind CloudFront in real use, so this
          // only matters for anything hitting the API cross-origin — set
          // explicitly rather than leaving index.ts's unrestricted-default
          // (unset-env-var) fallback in place for a real deployment.
          CORS_ALLOWED_ORIGINS: customDomain ? `https://${customDomain.domainName}` : "http://localhost:5283",
          // ask.ts calls both services directly (retrieval embedding +
          // grounded-answer generation) — literals, not forward references,
          // same reasoning as the worker's own EMBEDDING_SERVICE_URL above.
          EMBEDDING_SERVICE_URL: EMBEDDING_SERVICE_INTERNAL_URL,
          GENERATION_SERVICE_URL: GENERATION_SERVICE_INTERNAL_URL,
          // search.ts (query) and documents.ts's delete route (best-effort
          // index cleanup) both call the search service directly.
          ELASTICSEARCH_SERVICE_URL: ELASTICSEARCH_SERVICE_INTERNAL_URL,
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(appDbSecret, "username"),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
          AUTH0_ISSUER_BASE_URL: ecs.Secret.fromSecretsManager(auth0Config, "issuerBaseUrl"),
          AUTH0_AUDIENCE: ecs.Secret.fromSecretsManager(auth0Config, "audience"),
          AUTH0_MGMT_CLIENT_ID: ecs.Secret.fromSecretsManager(auth0ManagementConfig, "clientId"),
          AUTH0_MGMT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(auth0ManagementConfig, "clientSecret"),
        },
      },
      publicLoadBalancer: true,
    });
    apiService.targetGroup.configureHealthCheck({ path: "/api/health" });
    database.connections.allowDefaultPortFrom(apiService.service, "API service to RDS");
    documentsBucket.grantReadWrite(apiService.taskDefinition.taskRole);
    // upload-complete enqueues to ingest; nothing server-side sends to
    // export yet, but grant it now so the same gap doesn't resurface the
    // day an export route ships (matches the queue URL env vars above).
    ingestQueue.grantSendMessages(apiService.taskDefinition.taskRole);
    exportQueue.grantSendMessages(apiService.taskDefinition.taskRole);

    // Autoscale on request load, not CPU alone — this is a request/response
    // API, not a compute-bound job.
    const apiScaling = apiService.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
    apiScaling.scaleOnRequestCount("ScaleOnRequests", {
      requestsPerTarget: 500,
      targetGroup: apiService.targetGroup,
    });

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, "WorkerTaskDefinition", {
      // cpu bumped 512->1024 alongside the memory increase below — Fargate
      // only allows memoryLimitMiB above 4096 once cpu is at least 1024
      // (AWS's fixed cpu/memory pairing table for Fargate task sizes).
      cpu: 1024,
      // Raised 1024->6144 (2026-09-08) to match ZIP_MAX_SIZE_BYTES's own
      // bump to 2 GiB (see containerExpansion.ts) — a zip's raw buffer AND
      // its decompressed members can be live in memory at once, so this
      // needs real headroom above the 2 GiB ceiling itself, not just
      // barely fit it. These two numbers must move together.
      memoryLimitMiB: 6144,
      // Bumped from Fargate's 20 GiB default — PST ingest (see worker's
      // ingest.ts handlePstIngest) streams the whole S3 object to a local
      // temp file rather than buffering it in memory, since a real
      // eDiscovery PST can be multiple GB. This moves the size ceiling
      // from memory to disk; a PST larger than this still fails cleanly
      // (a pre-flight check against the document's known size_bytes,
      // before the download even starts — see PST_MAX_SIZE_BYTES) rather
      // than risking a mid-stream ENOSPC.
      ephemeralStorageGiB: 100,
    });
    workerTaskDefinition.addContainer("worker", {
      image: ecs.ContainerImage.fromAsset("../..", {
        file: "apps/edd-workbench/worker/Dockerfile",
        exclude: dockerAssetExcludes,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "edd-workbench-worker" }),
      environment: {
        EDD_WORKBENCH_INGEST_QUEUE_URL: ingestQueue.queueUrl,
        EDD_WORKBENCH_EXPORT_QUEUE_URL: exportQueue.queueUrl,
        EDD_WORKBENCH_OCR_QUEUE_URL: ocrQueue.queueUrl,
        EDD_WORKBENCH_EMBEDDING_QUEUE_URL: embeddingQueue.queueUrl,
        EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL: searchIndexQueue.queueUrl,
        // Deterministic Cloud Map DNS name (see GpuService below) — a
        // literal, not a reference to that construct, so this container
        // definition doesn't need to be declared after it.
        EMBEDDING_SERVICE_URL: EMBEDDING_SERVICE_INTERNAL_URL,
        ELASTICSEARCH_SERVICE_URL: ELASTICSEARCH_SERVICE_INTERNAL_URL,
        DB_HOST: database.instanceEndpoint.hostname,
        DB_PORT: database.instanceEndpoint.port.toString(),
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(appDbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
      },
    });
    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster,
      serviceName: "worker",
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0, // single-task queue consumer — 100% would block any deploy from ever proceeding
    });
    ingestQueue.grantConsumeMessages(workerTaskDefinition.taskRole);
    exportQueue.grantConsumeMessages(workerTaskDefinition.taskRole);
    // The worker isn't just a consumer of its own ingest queue — expanding
    // a container/attachment into child documents re-enqueues each one so
    // it gets fully processed by re-entering handleIngestMessage (see
    // containerExpansion.ts's expandMembers). Missing this grant doesn't
    // fail loudly: the child row's own INSERT/S3 upload succeed, then
    // SendMessageCommand throws AccessDenied, which (correctly) rolls back
    // that one member's transaction — so every real attachment/zip-member/
    // PST-message-attachment silently vanishes instead of ever appearing,
    // with no error visible anywhere until per-member failures started
    // being logged. Confirmed for real via CloudWatch: every failure this
    // session's "zip/msg/PST not working" report traced back to exactly
    // this missing grant, not application logic.
    ingestQueue.grantSendMessages(workerTaskDefinition.taskRole);
    // ingest.ts hands a text-layer-less pdf or an image/tiff off to the ocr
    // queue instead of processing it in-process — see that file's own
    // comment on why (avoiding blocking this queue behind a slow OCR job).
    ocrQueue.grantSendMessages(workerTaskDefinition.taskRole);
    // The worker both sends (ingest.ts's own hand-off) and consumes (its
    // third consumeQueue loop, handlers/embedding.ts) this queue — unlike
    // OCR, embedding has no wrapper service of its own to hold that grant
    // instead (see embedding.ts's own comment on why it lives here).
    embeddingQueue.grantSendMessages(workerTaskDefinition.taskRole);
    embeddingQueue.grantConsumeMessages(workerTaskDefinition.taskRole);
    searchIndexQueue.grantSendMessages(workerTaskDefinition.taskRole);
    searchIndexQueue.grantConsumeMessages(workerTaskDefinition.taskRole);
    documentsBucket.grantReadWrite(workerTaskDefinition.taskRole);
    database.connections.allowDefaultPortFrom(workerService, "Worker service to RDS");

    // Scale on queue backlog, not CPU — this workload is I/O/parsing bound
    // (streaming from S3, OLE/CFB and zip parsing), so backlog depth is the
    // signal that actually reflects "are we keeping up," not CPU%.
    const workerScaling = workerService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 10 });
    workerScaling.scaleOnMetric("ScaleOnIngestBacklog", {
      metric: ingestQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 5, change: +1 },
        { lower: 20, change: +2 },
      ],
    });

    // --- OCR service -------------------------------------------------------
    // A genuinely separate Fargate service from the worker above, consuming
    // its own queue — see ocrQueue's own comment for why this can't just be
    // a third consumeQueue loop bolted onto the worker process. Exposes a
    // small REST API too (POST /ocr, GET /health) — the stable, engine-
    // agnostic OCR contract (currently backed by a native Tesseract engine
    // running in-container; swappable later without touching ingest.ts or
    // this queue's consumer at all) — but that's not behind the ALB/
    // CloudFront: nothing outside the VPC needs to call it directly today,
    // only the queue-driven path in production. See
    // apps/edd-workbench/ocr-service for the actual code.
    //
    // Sized for real CPU-bound work, not the old Textract-polling task's
    // small "mostly idle, waiting on an async AWS job" footprint — this
    // task now does the actual page rasterization (pdftoppm) and OCR
    // (tesseract) computation itself. 2 vCPU / 4GB is a starting point for
    // typical scanned-document page counts; revisit if real usage shows
    // OOM kills or OCR_TIMEOUT_MS timeouts on larger documents.
    const ocrTaskDefinition = new ecs.FargateTaskDefinition(this, "OcrTaskDefinition", {
      cpu: 2048,
      memoryLimitMiB: 4096,
    });
    ocrTaskDefinition.addContainer("ocr", {
      image: ecs.ContainerImage.fromAsset("../..", {
        file: "apps/edd-workbench/ocr-service/Dockerfile",
        exclude: dockerAssetExcludes,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "edd-workbench-ocr" }),
      environment: {
        EDD_WORKBENCH_OCR_QUEUE_URL: ocrQueue.queueUrl,
        EDD_WORKBENCH_EMBEDDING_QUEUE_URL: embeddingQueue.queueUrl,
        EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL: searchIndexQueue.queueUrl,
        DB_HOST: database.instanceEndpoint.hostname,
        DB_PORT: database.instanceEndpoint.port.toString(),
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(appDbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
      },
    });
    const ocrService = new ecs.FargateService(this, "OcrService", {
      cluster,
      serviceName: "ocr",
      taskDefinition: ocrTaskDefinition,
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0, // single-task queue consumer, same reasoning as WorkerService
    });
    ocrQueue.grantConsumeMessages(ocrTaskDefinition.taskRole);
    // A successful OCR is itself a trigger for the embedding hand-off —
    // see ocrQueue.ts's own comment for why (mirrors ingest.ts's own
    // 'ready' hand-off for every other extractor).
    embeddingQueue.grantSendMessages(ocrTaskDefinition.taskRole);
    // Same hand-off, for the search index — see ocrQueue.ts's own comment.
    searchIndexQueue.grantSendMessages(ocrTaskDefinition.taskRole);
    // Read-only — unlike the worker, ocr-service never writes derived
    // artifacts back to S3, only a DB row (its extracted text/status).
    documentsBucket.grantRead(ocrTaskDefinition.taskRole);
    database.connections.allowDefaultPortFrom(ocrService, "OCR service to RDS");

    // Backlog depth, not CPU utilization, is still the right scaling signal
    // even though OCR is now CPU-bound work (rasterize + recognize) rather
    // than I/O-bound waiting on Textract: consumeQueue processes one
    // message at a time per task (see queues.ts), so a single task's CPU
    // sits near 100% whenever it's processing any one job at all, whether
    // the backlog is 1 message or 50 — that makes CPU utilization a noisy,
    // not-actually-proportional signal here. Backlog depth directly answers
    // the question that matters — "how many jobs are waiting?" — so it
    // stays the metric; only the per-task cpu/memory above needed to grow.
    const ocrScaling = ocrService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 5 });
    ocrScaling.scaleOnMetric("ScaleOnOcrBacklog", {
      metric: ocrQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 5, change: +1 },
        { lower: 20, change: +2 },
      ],
    });

    // --- GPU service (self-hosted Qwen3-Embedding-0.6B + Qwen3-4B via vLLM,
    // co-located on one instance) -------------------------------------------
    // A genuinely different compute shape from everything else in this
    // stack: Fargate has no GPU support at all, so this needs real EC2
    // capacity, not another Fargate task. Added as an EC2 capacity
    // provider on the SAME cluster (not a separate cluster/orchestrator —
    // there's no Kubernetes here, and there doesn't need to be one just
    // for this) so it still uses the same ECS task-definition/service/
    // logging patterns as every other service in this file.
    //
    // One instance, one task, two vLLM processes — replacing what used to
    // be two entirely separate instances/services (one embedding, one
    // generation). ECS treats GPU as an exclusive per-container
    // resourceRequirement: two containers each declaring `gpuCount: 1`
    // cannot both be placed on a single-GPU instance (ECS sums the
    // requirement across every container in a task/instance and refuses
    // to place if it exceeds what's available). The only way to actually
    // share one physical GPU between two model servers under ECS's
    // placement model is to run both inside ONE container as sibling
    // processes, with only one gpuCount:1 declared for the whole task —
    // the GPU sharing itself then happens the ordinary way two CUDA
    // processes share a card (each gets its own --gpu-memory-utilization
    // slice of VRAM; the driver time-slices compute between them). This
    // only became possible by moving off the original Qwen3-Embedding-8B
    // (14.11 GiB bf16 weights) + Qwen3-8B (~16GiB) pair, which never fit
    // one L4's ~22GiB together — see ai-model-decision.md's "Investigation:
    // smaller models" section for the quality-risk tradeoff this accepts
    // (not yet validated against real documents).
    //
    // "Warm on a schedule": the RAG cost-tier research this is built from
    // assumed Kubernetes tooling (KEDA Cron Scaler, Karpenter) that has no
    // equivalent in an ECS-only stack. The ECS-native translation used
    // here: the ASG's own managed scaling keeps EC2 capacity matched to
    // whatever the ECS service's desiredCount actually needs (the same
    // "compute reacts to demand" idea Karpenter implements for EKS), and
    // two EventBridge Scheduler rules are the only thing that ever touches
    // desiredCount directly (1 during business hours, 0 outside) — see
    // GpuScheduleStart/Stop below. Nothing schedules the ASG's own
    // capacity separately; that would risk the two drifting out of sync.
    // A launch template, not the AutoScalingGroup's own inline instanceType/
    // machineImage props — those trigger CDK's legacy Launch Configuration
    // path underneath, which this account rejects outright ("The Launch
    // Configuration creation operation is not available in your account" —
    // a real CREATE_FAILED, not a guessed-around risk). Needs its own
    // explicit security group since the launch-template path doesn't
    // auto-create one the way the legacy path did.
    const gpuInstanceSecurityGroup = new ec2.SecurityGroup(this, "GpuInstanceSecurityGroup", {
      vpc,
      description: "EDD Workbench GPU instance (embedding + generation) - outbound only (pulls vLLM image and model weights)",
      allowAllOutbound: true,
    });
    const gpuInstanceRole = new iam.Role(this, "GpuInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2ContainerServiceforEC2Role"),
      ],
    });
    const gpuLaunchTemplate = new ec2.LaunchTemplate(this, "GpuLaunchTemplate", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.G6, ec2.InstanceSize.XLARGE),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
      securityGroup: gpuInstanceSecurityGroup,
      // On-demand — see git history (2026-09-08) for the sustained
      // g6.xlarge Spot capacity shortage that motivated this; no
      // spotOptions here at all now.
      // AsgCapacityProvider needs both of these to be explicit and
      // pre-attached — it can't inject an instance profile/role or amend
      // user data on an already-created launch template, unlike the legacy
      // inline-props path. Role: standard ECS-agent EC2 instance role, so
      // the agent can register the instance with the cluster.
      role: gpuInstanceRole,
      // AsgCapacityProvider needs to append the ECS-agent bootstrap
      // (ECS_CLUSTER=... in /etc/ecs/ecs.config) to this launch template's
      // user data. It can only do that if we hand it an explicit UserData
      // object up front — without this, CDK can't "expose" user data on an
      // already-created launch template and synth fails.
      userData: ec2.UserData.forLinux(),
      // Default 30GB root volume is tight once you add the GPU AMI's own
      // footprint, the vLLM Docker image, and both models' downloaded
      // weights (all re-downloaded on every scheduled start in this v1 —
      // see the bootstrap comment above the task definition).
      blockDevices: [{ deviceName: "/dev/xvda", volume: autoscaling.BlockDeviceVolume.ebs(100) }],
    });
    const gpuAsg = new autoscaling.AutoScalingGroup(this, "GpuAsg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate: gpuLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
    });
    const gpuCapacityProvider = new ecs.AsgCapacityProvider(this, "GpuCapacityProvider", {
      autoScalingGroup: gpuAsg,
      enableManagedScaling: true,
      targetCapacityPercent: 100,
      // Managed termination protection would stop the ASG from
      // terminating this instance while a task is running on it — the
      // opposite of what "actually stop paying for it overnight" needs.
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(gpuCapacityProvider);

    // Private-DNS Cloud Map namespace so the worker/api can reach this
    // service by a stable internal name (EMBEDDING_SERVICE_INTERNAL_URL /
    // GENERATION_SERVICE_INTERNAL_URL above) rather than an IP that
    // changes every time the instance is replaced. Both URLs now resolve
    // to the SAME host, differing only by port (8000 embedding, 8001
    // generation).
    const internalNamespace = new servicediscovery.PrivateDnsNamespace(this, "InternalNamespace", {
      name: "edd-workbench.internal",
      vpc,
    });

    const gpuSecurityGroup = new ec2.SecurityGroup(this, "GpuServiceSecurityGroup", {
      vpc,
      description: "EDD Workbench GPU service (vLLM embedding + generation) - inbound from worker (embedding port only) and api (both ports)",
      allowAllOutbound: true, // needs real internet egress: pulls the vLLM image from Docker Hub and the model weights from Hugging Face
    });
    gpuSecurityGroup.addIngressRule(
      workerService.connections.securityGroups[0],
      ec2.Port.tcp(8000),
      // EC2 security group rule descriptions reject apostrophes (and most
      // other punctuation) — found the hard way via a real CREATE_FAILED,
      // not guessed up front.
      "Worker service to embedding port (vLLM OpenAI-compatible API)",
    );
    // ask.ts (api service) embeds the incoming question directly, alongside
    // the worker's existing use of the embedding port for document ingest,
    // and is the only caller of the generation port.
    gpuSecurityGroup.addIngressRule(
      apiService.service.connections.securityGroups[0],
      ec2.Port.tcp(8000),
      "Api service to embedding port (vLLM OpenAI-compatible API)",
    );
    gpuSecurityGroup.addIngressRule(
      apiService.service.connections.securityGroups[0],
      ec2.Port.tcp(8001),
      "Api service to generation port (vLLM OpenAI-compatible API)",
    );

    const gpuTaskDefinition = new ecs.Ec2TaskDefinition(this, "GpuTaskDefinition", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });
    gpuTaskDefinition.addContainer("gpu", {
      // The official vLLM image, not a Dockerfile of our own — there's no
      // application code here to bake in, only a public inference engine.
      // entryPoint overrides the image's default ("vllm serve", which is
      // why the original single-model commands were just trailing
      // "--model ..." args) to launch BOTH vLLM servers as sibling
      // background processes sharing this one container — see this
      // section's own top comment for why that's the only way to actually
      // share one physical GPU under ECS's placement model. `wait -n`
      // exits (and lets ECS restart the whole task) the moment either
      // process dies, rather than silently limping along on just one
      // model — real deploy verification found this needs bash, not sh:
      // the image's /bin/sh is a POSIX-minimal shell that rejects `-n` as
      // an illegal option ("sh: 1: wait: Illegal option -n"), immediately
      // exiting 2 and crash-looping the task. bash is present on this
      // CUDA/Ubuntu-based image and supports the flag.
      image: ecs.ContainerImage.fromRegistry("vllm/vllm-openai:latest"),
      entryPoint: ["bash", "-c"],
      gpuCount: 1,
      // g6.xlarge has 16GB system RAM (distinct from the L4's own ~22GiB
      // VRAM, which is what --gpu-memory-utilization below governs) —
      // leave real headroom for the host OS/ECS agent rather than
      // reserving all of it. Genuinely untested at time of writing
      // whether two co-resident vLLM processes' real system-RAM footprint
      // fits comfortably here: the smaller 4B models need far less than
      // the original single 8B model's own 14000MiB reservation, but
      // running two processes instead of one is the open question — watch
      // this in staging; g6.2xlarge (same GPU, more system RAM/vCPU) is a
      // one-line fix if it's tight.
      memoryReservationMiB: 14000,
      // Two real deploy attempts failed here before this one worked out
      // why. Attempt 1 (Qwen3-Embedding-4B + Qwen3-4B, launched
      // concurrently): both loaded at an *identical* 7.56 GiB of weights
      // (same underlying 4B dense architecture — the embedding variant
      // isn't meaningfully smaller than the generation model), so combined
      // weights alone (~15.1GiB) already ate most of the card before
      // either could allocate KV cache. Attempt 2 (switched to the much
      // smaller Qwen3-Embedding-0.6B, ~1.2GiB weights, still launched
      // concurrently): failed anyway — the *smaller* model's engine
      // reported "Available KV cache memory: -4.86 GiB" despite its own
      // usage being only ~1.4GiB against a 0.25-fraction (~5.5GiB) budget,
      // proving the real bug wasn't model size, it was concurrency: each
      // vLLM process profiles *actual current free VRAM* at startup
      // (not a private slice reserved just for it), so launching both
      // engines at once means each one's memory profiling step races
      // against the other's concurrent weight loading — whichever
      // profiles second sees a card that's already been eaten into by
      // its sibling, regardless of what its own --gpu-memory-utilization
      // fraction was budgeted for. There's no flag that reserves a private
      // VRAM slice per process; the two have to simply not start at the
      // same time. Fix: sequence the startup — launch the smaller
      // embedding server, block until its /health endpoint responds
      // (i.e. its engine has fully initialized, including KV cache
      // allocation, so its VRAM footprint is final and small), and only
      // then launch generation, which now profiles a card with just
      // embedding's already-settled ~1.4GiB on it instead of a second
      // engine's still-growing footprint. Polls via python3 (guaranteed
      // present on this image) rather than curl (not guaranteed). Once
      // sequenced, the original generous fractions are safe again —
      // 0.3/0.6 leaves real headroom on both sides now that there's no
      // race to lose. max-model-len values unchanged — chunks
      // (chunking.ts) top out around 1200 chars, nowhere near either cap.
      command: [
        "vllm serve Qwen/Qwen3-Embedding-0.6B --port 8000 --dtype auto --max-model-len 4096 " +
          '--gpu-memory-utilization 0.3 --hf-overrides \'{"is_matryoshka": true, "matryoshka_dimensions": [1024]}\' & ' +
          "until python3 -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)\" 2>/dev/null; do sleep 5; done && " +
          "vllm serve Qwen/Qwen3-4B --port 8001 --dtype auto --max-model-len 8192 --gpu-memory-utilization 0.6 & " +
          "wait -n",
      ],
      portMappings: [{ containerPort: 8000 }, { containerPort: 8001 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "edd-workbench-gpu" }),
    });
    const gpuService = new ecs.Ec2Service(this, "GpuService", {
      cluster,
      serviceName: "gpu",
      taskDefinition: gpuTaskDefinition,
      // Starts at 0 — only ever changed by the EventBridge Scheduler rules
      // below, never by a deploy. A real deploy (a new image/task revision)
      // while this happens to be scheduled off simply updates the service
      // definition without starting any tasks, exactly as intended.
      desiredCount: 0,
      capacityProviderStrategies: [{ capacityProvider: gpuCapacityProvider.capacityProviderName, weight: 1 }],
      securityGroups: [gpuSecurityGroup],
      cloudMapOptions: {
        cloudMapNamespace: internalNamespace,
        name: "gpu",
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0, // single-instance service that spends most of its life at desiredCount 0 — 100% would block any deploy
    });

    // One schedule pair, not two — both models always started/stopped
    // together anyway even when split across two services (identical
    // 9am-18:00 UK window), so a single desiredCount flip now covers both.
    // Universal targets invoke an AWS API action directly with no Lambda
    // in between; the {{service}} segment of the ARN is the AWS SDK
    // service identifier (lowercase "ecs"), but the request body fields
    // are PascalCase (Cluster/Service/DesiredCount) — a real CREATE_FAILED
    // ("missing field(s): Service") proved the lowercase camelCase guess
    // wrong; confirmed PascalCase via real-world universal-target examples
    // before fixing this.
    const gpuSchedulerRole = new iam.Role(this, "GpuSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    gpuSchedulerRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["ecs:UpdateService"], resources: [gpuService.serviceArn] }),
    );

    // Business hours only, UK time — ScheduleExpressionTimezone handles
    // the BST/GMT clock change automatically, unlike a fixed UTC cron
    // would. 9am-6pm, narrowed from 7am-7pm (2026-09-04) once real usage
    // data confirmed actual usage sits inside that window — every hour
    // trimmed is real, direct savings at g6.xlarge's on-demand rate.
    new scheduler.CfnSchedule(this, "GpuScheduleStart", {
      scheduleExpression: "cron(0 9 ? * MON-FRI *)",
      scheduleExpressionTimezone: "Europe/London",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: "arn:aws:scheduler:::aws-sdk:ecs:updateService",
        roleArn: gpuSchedulerRole.roleArn,
        input: JSON.stringify({ Cluster: cluster.clusterName, Service: gpuService.serviceName, DesiredCount: 1 }),
      },
    });
    new scheduler.CfnSchedule(this, "GpuScheduleStop", {
      scheduleExpression: "cron(0 18 ? * MON-FRI *)",
      scheduleExpressionTimezone: "Europe/London",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: "arn:aws:scheduler:::aws-sdk:ecs:updateService",
        roleArn: gpuSchedulerRole.roleArn,
        input: JSON.stringify({ Cluster: cluster.clusterName, Service: gpuService.serviceName, DesiredCount: 0 }),
      },
    });

    // --- Search service (self-hosted Elasticsearch, full-text document
    // search) --------------------------------------------------------------
    // EC2-backed like GpuService above, but two deliberate differences: no
    // GPU — a general-purpose instance is all a search index needs — and
    // always on, no EventBridge schedule. Unlike the GPU-backed service
    // (scheduled off specifically because GPU-hours are expensive), there's
    // no comparable cost pressure for a small general-purpose box, and
    // search needs to be available whenever the app is used, not just
    // 9am-18:00 UK time.
    //
    // Durability: the Elasticsearch data path lives on this launch
    // template's own EBS volume, which is NOT a stable/reattachable volume
    // across instance replacement — a fresh ASG-launched instance gets a
    // fresh empty volume. EFS was considered and rejected (Elastic itself
    // discourages NFS-backed data paths — a real corruption risk, a worse
    // trade than the problem it solves). The correct fix is Elasticsearch's
    // own S3 snapshot repository (register searchSnapshotsBucket below via
    // ES's Snapshot Lifecycle Management API — a manual one-time setup
    // step, not something CDK itself can configure), with
    // reindexSearch.ts as the recovery path for the gap since the last
    // snapshot (cheap — it only replays already-extracted Postgres text,
    // no re-OCR needed).
    const searchSnapshotsBucket = new s3.Bucket(this, "SearchSnapshotsBucket", {
      bucketName: `edd-workbench-${environmentName}-search-snapshots`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const searchInstanceSecurityGroup = new ec2.SecurityGroup(this, "SearchInstanceSecurityGroup", {
      vpc,
      description: "EDD Workbench search (Elasticsearch) instance - outbound only",
      allowAllOutbound: true,
    });
    const searchInstanceRole = new iam.Role(this, "SearchInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2ContainerServiceforEC2Role"),
      ],
    });

    const searchLaunchTemplate = new ec2.LaunchTemplate(this, "SearchLaunchTemplate", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.LARGE),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      securityGroup: searchInstanceSecurityGroup,
      role: searchInstanceRole,
      userData: ec2.UserData.forLinux(),
      // 100GB — resizable later if real document volume needs more; no
      // GPU-model-weights footprint to plan around here, just the index
      // itself.
      blockDevices: [{ deviceName: "/dev/xvda", volume: autoscaling.BlockDeviceVolume.ebs(100) }],
    });
    const searchAsg = new autoscaling.AutoScalingGroup(this, "SearchAsg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate: searchLaunchTemplate,
      // Always exactly 1 — no schedule flips this the way GpuService's own
      // ASG gets flipped 0/1 on a business-hours cron; see this section's
      // own top comment for why.
      minCapacity: 1,
      maxCapacity: 1,
    });
    const searchCapacityProvider = new ecs.AsgCapacityProvider(this, "SearchCapacityProvider", {
      autoScalingGroup: searchAsg,
      enableManagedScaling: true,
      targetCapacityPercent: 100,
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(searchCapacityProvider);

    const searchSecurityGroup = new ec2.SecurityGroup(this, "SearchServiceSecurityGroup", {
      vpc,
      description: "EDD Workbench search service (Elasticsearch) - inbound from api and worker only",
      allowAllOutbound: true,
    });
    // Both need it: the api service for real search queries (search.ts),
    // the worker for indexing writes (searchIndex.ts). The migrate task
    // (reindexSearch.ts's own disaster-recovery path) gets its matching
    // ingress rule down by migrateSecurityGroup's own declaration below —
    // that security group doesn't exist yet at this point in the file.
    searchSecurityGroup.addIngressRule(
      apiService.service.connections.securityGroups[0],
      ec2.Port.tcp(9200),
      "Api service to search service (Elasticsearch)",
    );
    searchSecurityGroup.addIngressRule(
      workerService.connections.securityGroups[0],
      ec2.Port.tcp(9200),
      "Worker service to search service (Elasticsearch)",
    );

    const searchTaskDefinition = new ecs.Ec2TaskDefinition(this, "SearchTaskDefinition", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });
    // The Elasticsearch container's own AWS SDK calls (its S3 repository
    // plugin, for snapshots) run under the ECS *task* role, not the EC2
    // *instance* role above — a real 403 (AccessDenied on s3:PutObject)
    // from a live snapshot-repo registration attempt confirmed this the
    // hard way, not guessed. Read/write/delete/list, matching what the
    // plugin actually needs to create, restore, and prune snapshots.
    searchSnapshotsBucket.grantReadWrite(searchTaskDefinition.taskRole);
    searchSnapshotsBucket.grantDelete(searchTaskDefinition.taskRole);
    searchTaskDefinition.addContainer("search", {
      // Official image, not a Dockerfile of our own — same "no application
      // code to bake in" reasoning as vLLM's own image choice.
      image: ecs.ContainerImage.fromRegistry("docker.elastic.co/elasticsearch/elasticsearch:8.15.0"),
      // m6i.large has 8GB RAM — leave real headroom for the host OS/ECS
      // agent rather than reserving all of it for the container, same
      // reasoning as EmbeddingTaskDefinition's own memoryReservationMiB.
      memoryReservationMiB: 7000,
      environment: {
        "discovery.type": "single-node",
        // No app-level auth on this internal service — protected purely by
        // the security group above, same posture as vLLM's own HTTP API
        // (embedding/generation) already has.
        "xpack.security.enabled": "false",
        // Half the instance's RAM, standard Elasticsearch heap-sizing
        // guidance (leaves the other half for the OS page cache, which
        // Lucene relies on).
        ES_JAVA_OPTS: "-Xms4g -Xmx4g",
      },
      portMappings: [{ containerPort: 9200 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "edd-workbench-search" }),
    });
    new ecs.Ec2Service(this, "SearchService", {
      cluster,
      serviceName: "search",
      taskDefinition: searchTaskDefinition,
      desiredCount: 1,
      capacityProviderStrategies: [{ capacityProvider: searchCapacityProvider.capacityProviderName, weight: 1 }],
      securityGroups: [searchSecurityGroup],
      cloudMapOptions: {
        cloudMapNamespace: internalNamespace,
        name: "search",
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
    });

    // --- One-off migration task ------------------------------------------
    // RDS sits in an isolated subnet with no path from a laptop, so
    // migrations can't run the way local dev runs them. This is a bare
    // FargateTaskDefinition (deliberately no Service — it should run once
    // per deploy and stop, not stay up), reusing the same serverImage as
    // the api service. Connects with *owner* credentials (unlike api/worker
    // above) because it needs to create/alter the edd_workbench_app role
    // and its RLS policies, which that low-privilege role cannot do to
    // itself. Runs setAppPassword.ts right after migrate.ts so the
    // Postgres role's actual password always matches what appDbSecret
    // holds — see that script's comment for why this can't just be a
    // one-time manual step the way local dev's docker-exec/ALTER-ROLE is.
    const migrateSecurityGroup = new ec2.SecurityGroup(this, "MigrateSecurityGroup", {
      vpc,
      description: "EDD Workbench one-off migration task - outbound only",
      allowAllOutbound: true,
    });
    database.connections.allowDefaultPortFrom(migrateSecurityGroup, "Migration task to RDS");
    // Lets this same task definition also run reindexSearch.ts (via a
    // command override at RunTask time) — the disaster-recovery path after
    // a lost/never-created Elasticsearch index. It's the only task
    // definition with DB *owner* credentials already securely wired
    // (`secrets:` below, not a raw env override), which that script needs
    // to read across every org bypassing RLS.
    searchSecurityGroup.addIngressRule(
      migrateSecurityGroup,
      ec2.Port.tcp(9200),
      "Migrate task (reindexSearch.ts) to search service (Elasticsearch)",
    );

    const migrateTaskDefinition = new ecs.FargateTaskDefinition(this, "MigrateTaskDefinition", {
      cpu: 256,
      // 512 wasn't enough — reindexSearch.ts OOM-killed (exit 137) loading
      // all ~9,400 real documents' metadata in one unpaginated query. Now
      // paged (500 rows at a time — see reindexSearch.ts's own comment),
      // but keeping some headroom above bare minimum for tsx/pg's own
      // baseline footprint, not just "the current page fits."
      memoryLimitMiB: 1024,
    });
    migrateTaskDefinition.addContainer("migrate", {
      image: serverImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "edd-workbench-migrate" }),
      command: [
        "sh",
        "-c",
        "node_modules/.bin/tsx packages/edd-workbench-core/src/migrate.ts && node_modules/.bin/tsx packages/edd-workbench-core/src/setAppPassword.ts",
      ],
      environment: {
        DB_HOST: database.instanceEndpoint.hostname,
        DB_PORT: database.instanceEndpoint.port.toString(),
        // Only reindexSearch.ts (run via a command override) reads this —
        // migrate.ts/setAppPassword.ts's own default command never touches
        // it — but it's simplest baked in here rather than requiring every
        // RunTask override to also override environment.
        ELASTICSEARCH_SERVICE_URL: ELASTICSEARCH_SERVICE_INTERNAL_URL,
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
      },
    });

    // --- Edge: CloudFront ---------------------------------------------
    // SPA client-side routing (an unknown path like /matters/123 is the
    // SPA's own job to handle, not a real 403/404 from S3) used to be done
    // via the distribution's errorResponses — but that applies to the
    // WHOLE distribution, not just this behavior, so it was also rewriting
    // every genuine 403/404 the API returned (e.g. "not a member of any
    // organization") into a 200 HTML page. Real bug, found by reproducing
    // it directly: hitting the ALB with a real token gave the correct JSON
    // 403, but the same request through CloudFront came back as the SPA's
    // index.html. A CloudFront Function attached only to this behavior
    // does the same rewrite (no dot in the path → serve index.html) without
    // ever touching the /api/* behavior, since function associations are
    // per-behavior, unlike errorResponses.
    const spaRoutingFunction = new cloudfront.Function(this, "SpaRoutingFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (!request.uri.includes(".")) {
    request.uri = "/index.html";
  }
  return request;
}
`),
    });

    // One distribution, two behaviors — default serves the SPA, /api/* forwards
    // to the ALB uncached. Single origin domain from the browser's point of
    // view means no CORS anywhere, which matters once Auth0 bearer tokens are
    // in play (build plan §1).
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: customDomain ? [customDomain.domainName] : undefined,
      certificate: customDomain
        ? acm.Certificate.fromCertificateArn(this, "CustomDomainCertificate", customDomain.certificateArn)
        : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: spaRoutingFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.LoadBalancerV2Origin(apiService.loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
    });

    // Uploads the built SPA (run `npm run build` in apps/edd-workbench/client
    // first — see that app's .env.production.example for the values it needs
    // baked in) and invalidates the CloudFront cache so a deploy doesn't
    // leave stale assets behind at the edge. Source directory must exist at
    // synth time — this stack cannot build the client itself (that needs
    // real Auth0 values chosen per environment, not something CDK should be
    // deciding).
    //
    // Split into two deployments deliberately: S3 sets no Cache-Control
    // header at all by default, which isn't the "don't cache" you'd expect
    // — a browser can apply its own heuristic freshness window to a plain
    // GET even with no explicit Cache-Control present (the same category of
    // bug already found and fixed for /api/matters's ETag/304 behavior —
    // see index.ts's own comment), so a real deploy landing at the edge
    // (confirmed via a completed CloudFront invalidation) still wasn't
    // enough — a browser could keep serving a stale index.html, and
    // therefore the *old* hashed JS bundle it references, well after the
    // fix it needed was already live. The hashed assets/* files are safe to
    // cache forever (their filename changes whenever their content does,
    // so there's nothing to go stale) — only index.html itself, the one
    // file whose content changes without its own filename changing, needs
    // an explicit no-cache.
    new s3deploy.BucketDeployment(this, "SpaDeployment", {
      sources: [s3deploy.Source.asset("../../apps/edd-workbench/client/dist")],
      destinationBucket: spaBucket,
      exclude: ["index.html"],
      distribution,
      distributionPaths: ["/*"],
    });
    new s3deploy.BucketDeployment(this, "SpaIndexDeployment", {
      sources: [s3deploy.Source.asset("../../apps/edd-workbench/client/dist")],
      destinationBucket: spaBucket,
      exclude: ["*"],
      include: ["index.html"],
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
      distribution,
      distributionPaths: ["/*"],
    });

    new cdk.CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
    if (customDomain) {
      // CloudFront is region-agnostic from a DNS point of view — the
      // record just needs to point at the distribution's own domain, not
      // any region-specific endpoint.
      new cdk.CfnOutput(this, "CustomDomainDnsInstructions", {
        value: `Add a CNAME: ${customDomain.domainName} -> ${distribution.distributionDomainName}`,
      });
    }
    new cdk.CfnOutput(this, "DatabaseOwnerSecretArn", { value: database.secret!.secretArn });
    new cdk.CfnOutput(this, "DocumentsBucketName", { value: documentsBucket.bucketName });
    new cdk.CfnOutput(this, "Auth0ConfigSecretArn", { value: auth0Config.secretArn });
    new cdk.CfnOutput(this, "Auth0ManagementConfigSecretArn", { value: auth0ManagementConfig.secretArn });
    // Consumed by scripts/run-migrations.mjs to actually invoke the
    // migration task after each deploy — ECS RunTask needs all four.
    new cdk.CfnOutput(this, "ClusterArn", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "MigrateTaskDefinitionArn", { value: migrateTaskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "PrivateSubnetIds", { value: vpc.privateSubnets.map((s) => s.subnetId).join(",") });
    new cdk.CfnOutput(this, "MigrateSecurityGroupId", { value: migrateSecurityGroup.securityGroupId });
  }
}
