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
      multiAz: true,
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
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(appDbSecret, "username"),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
          AUTH0_ISSUER_BASE_URL: ecs.Secret.fromSecretsManager(auth0Config, "issuerBaseUrl"),
          AUTH0_AUDIENCE: ecs.Secret.fromSecretsManager(auth0Config, "audience"),
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
      cpu: 512,
      memoryLimitMiB: 1024,
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

    const migrateTaskDefinition = new ecs.FargateTaskDefinition(this, "MigrateTaskDefinition", {
      cpu: 256,
      memoryLimitMiB: 512,
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
    // baked in) and invalidates the cache so a deploy doesn't leave stale
    // assets behind. Source directory must exist at synth time — this stack
    // cannot build the client itself (that needs real Auth0 values chosen
    // per environment, not something CDK should be deciding).
    new s3deploy.BucketDeployment(this, "SpaDeployment", {
      sources: [s3deploy.Source.asset("../../apps/edd-workbench/client/dist")],
      destinationBucket: spaBucket,
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
    // Consumed by scripts/run-migrations.mjs to actually invoke the
    // migration task after each deploy — ECS RunTask needs all four.
    new cdk.CfnOutput(this, "ClusterArn", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "MigrateTaskDefinitionArn", { value: migrateTaskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "PrivateSubnetIds", { value: vpc.privateSubnets.map((s) => s.subnetId).join(",") });
    new cdk.CfnOutput(this, "MigrateSecurityGroupId", { value: migrateSecurityGroup.securityGroupId });
  }
}
