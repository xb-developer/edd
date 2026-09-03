// Invokes reindexSearch.ts (packages/edd-workbench-core/src/reindexSearch.ts)
// against a real deployed environment via ECS RunTask — same "no path from
// a laptop" reasoning as run-migrations.mjs, reusing the migrate task
// definition (the only one with DB *owner* credentials already securely
// wired) with its command overridden instead of a task definition of its
// own. The disaster-recovery path after a lost/never-created Elasticsearch
// index — see reindexSearch.ts's own comment for when to reach for this.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ECSClient, RunTaskCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";

const stackName = process.argv[2];
if (!stackName) {
  console.error("Usage: node scripts/run-reindex.mjs <stack-name>");
  process.exit(1);
}

const region = process.env.AWS_REGION ?? "eu-west-2";
const cfn = new CloudFormationClient({ region });
const ecs = new ECSClient({ region });

async function getOutputs() {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  for (const key of ["ClusterArn", "MigrateTaskDefinitionArn", "PrivateSubnetIds", "MigrateSecurityGroupId"]) {
    if (!outputs[key]) throw new Error(`Stack output ${key} not found — has the stack finished deploying?`);
  }
  return outputs;
}

async function run() {
  const outputs = await getOutputs();
  console.log("Starting reindex task...");

  const { tasks, failures } = await ecs.send(
    new RunTaskCommand({
      cluster: outputs.ClusterArn,
      taskDefinition: outputs.MigrateTaskDefinitionArn,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: outputs.PrivateSubnetIds.split(","),
          securityGroups: [outputs.MigrateSecurityGroupId],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            // "migrate" — the container name migrateTaskDefinition.addContainer
            // was given, not this script's own name.
            name: "migrate",
            command: ["sh", "-c", "node_modules/.bin/tsx packages/edd-workbench-core/src/reindexSearch.ts"],
          },
        ],
      },
    }),
  );

  if (failures?.length) {
    throw new Error(`RunTask failed: ${JSON.stringify(failures)}`);
  }
  const taskArn = tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error("RunTask returned no task ARN");
  console.log(`Task started: ${taskArn}`);
  console.log("Waiting for it to finish (check CloudWatch Logs group /ecs/edd-workbench-migrate for output)...");

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { tasks: polled } = await ecs.send(new DescribeTasksCommand({ cluster: outputs.ClusterArn, tasks: [taskArn] }));
    const task = polled?.[0];
    if (task?.lastStatus === "STOPPED") {
      const exitCode = task.containers?.[0]?.exitCode;
      if (exitCode === 0) {
        console.log("Reindex task completed successfully.");
        return;
      }
      throw new Error(`Reindex task exited with code ${exitCode}: ${task.stoppedReason}`);
    }
    console.log(`Status: ${task?.lastStatus ?? "unknown"}...`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
