// Invokes the migration task built by the CDK stack (MigrateTaskDefinition)
// via ECS RunTask, then polls until it stops and reports its exit code —
// this is the "actually run migrations against RDS" step, needed because
// RDS lives in an isolated subnet with no path from a laptop (see the
// stack's own comment on migrateSecurityGroup for the full reasoning).
// Reads everything it needs from the stack's own CfnOutputs rather than
// hardcoding cluster/task/network details here, so this script keeps
// working if any of those change.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ECSClient, RunTaskCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";

const stackName = process.argv[2];
if (!stackName) {
  console.error("Usage: node scripts/run-migrations.mjs <stack-name>");
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
  console.log("Starting migration task...");

  const { tasks, failures } = await ecs.send(
    new RunTaskCommand({
      cluster: outputs.ClusterArn,
      taskDefinition: outputs.MigrateTaskDefinitionArn,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: outputs.PrivateSubnetIds.split(","),
          securityGroups: [outputs.MigrateSecurityGroupId],
          // Private-with-egress subnets reach the internet via NAT, not a
          // public IP — the task doesn't need (and shouldn't have) one.
          assignPublicIp: "DISABLED",
        },
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

  // Simple poll loop rather than the SDK's built-in waiter — this task
  // finishes in seconds to low minutes, so a fixed 5s interval is plenty
  // responsive without the waiter's own configuration surface.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { tasks: polled } = await ecs.send(new DescribeTasksCommand({ cluster: outputs.ClusterArn, tasks: [taskArn] }));
    const task = polled?.[0];
    if (task?.lastStatus === "STOPPED") {
      const exitCode = task.containers?.[0]?.exitCode;
      if (exitCode === 0) {
        console.log("Migration task completed successfully.");
        return;
      }
      throw new Error(`Migration task exited with code ${exitCode}: ${task.stoppedReason}`);
    }
    console.log(`Status: ${task?.lastStatus ?? "unknown"}...`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
