data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${var.name_prefix}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "codebuild_permissions" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.codebuild.arn}:*"]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.build_source.arn}/*"]
  }
  # The source bucket is SSE-KMS encrypted (source.tf) - s3:GetObject alone
  # isn't enough, decrypting the object also needs kms:Decrypt on the key.
  # Found by actually running a build, not by planning/validating.
  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [aws_ecr_repository.api.arn, aws_ecr_repository.worker.arn]
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name   = "${var.name_prefix}-codebuild-permissions"
  role   = aws_iam_role.codebuild.id
  policy = data.aws_iam_policy_document.codebuild_permissions.json
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/codebuild/${var.name_prefix}-build"
  retention_in_days = 30
  tags              = var.tags
}

locals {
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"

  # Builds both Dockerfile targets (cloud-backend/Dockerfile's api/worker) and
  # pushes both - one CodeBuild run produces everything ECS needs.
  buildspec = <<-EOT
    version: 0.2
    phases:
      pre_build:
        commands:
          - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
      build:
        commands:
          - docker build --target api -t $API_REPO_URI:latest -f cloud-backend/Dockerfile .
          - docker build --target worker -t $WORKER_REPO_URI:latest -f cloud-backend/Dockerfile .
      post_build:
        commands:
          - docker push $API_REPO_URI:latest
          - docker push $WORKER_REPO_URI:latest
    EOT
}

resource "aws_codebuild_project" "build" {
  name         = "${var.name_prefix}-build"
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    # Required for `docker build`/`docker push` to work inside the build
    # container at all (Docker-in-Docker).
    privileged_mode = true

    environment_variable {
      name  = "ECR_REGISTRY"
      value = local.ecr_registry
    }
    environment_variable {
      name  = "API_REPO_URI"
      value = aws_ecr_repository.api.repository_url
    }
    environment_variable {
      name  = "WORKER_REPO_URI"
      value = aws_ecr_repository.worker.repository_url
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.build_source.bucket}/source.zip"
    buildspec = local.buildspec
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild.name
    }
  }

  tags = var.tags
}
