# Execution role: what ECS itself needs (pull the image, write logs, read
# the secrets referenced in the task definition's `secrets` block).
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = distinct(values(var.environment_secrets))
  }
  # The secrets above are SSE-KMS encrypted - GetSecretValue alone isn't
  # enough, ECS also needs kms:Decrypt on the key to actually read them.
  # Same shape as the CodeBuild fix in modules/cicd/codebuild.tf - found by
  # running a real deployment, not by planning/validating.
  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(var.environment_secrets) > 0 ? 1 : 0
  name   = "${var.name_prefix}-read-app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the APPLICATION CODE inside the container is allowed to do
# at runtime — this is the identity the AWS SDK calls inside cloud-backend
# actually run as (S3DocumentStore, Secrets Manager if read at runtime rather
# than injected, etc.). Deliberately separate from the execution role above.
resource "aws_iam_role" "api_task" {
  name               = "${var.name_prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role" "worker_task" {
  name               = "${var.name_prefix}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

# Both the API (presigned URLs, uploads) and the workers (extraction reads,
# nothing else writes raw bytes) need read/write to the repository bucket —
# scoped to that one bucket only, per Section 7.1's "nothing server-side
# beyond the Backend can reach it" boundary.
data "aws_iam_policy_document" "repository_access" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.repository_bucket_arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.repository_bucket_arn]
  }
}

resource "aws_iam_role_policy" "api_repository_access" {
  name   = "${var.name_prefix}-api-repository-access"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.repository_access.json
}

resource "aws_iam_role_policy" "worker_repository_access" {
  name   = "${var.name_prefix}-worker-repository-access"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.repository_access.json
}
