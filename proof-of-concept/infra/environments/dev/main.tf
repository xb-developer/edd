terraform {
  # Bootstrapped in infra/bootstrap/ (Section 10.2: "S3 + DynamoDB locking,
  # restricted access") — that state bucket/lock table now exist for real.
  backend "s3" {
    bucket         = "edd-workbench-terraform-state"
    key            = "dev/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "edd-workbench-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge(var.tags, { Environment = var.environment })
  }
}

locals {
  name_prefix = "edd-${var.environment}"
}

# One shared KMS key for this environment's RDS/S3 encryption (Section 7.2).
# Per-tenant keys are an application-level concern the Backend creates
# dynamically via the AWS SDK as each firm onboards (the number of tenants
# is unbounded and not knowable at `terraform apply` time) — not something
# this static infrastructure declares up front.
resource "aws_kms_key" "this" {
  description             = "${local.name_prefix} - RDS/S3 encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.this.key_id
}

module "network" {
  source      = "../../modules/network"
  name_prefix = local.name_prefix
  azs         = var.azs
  tags        = var.tags
}

module "security" {
  source      = "../../modules/security"
  name_prefix = local.name_prefix
  vpc_id      = module.network.vpc_id
  tags        = var.tags
}

module "database" {
  source              = "../../modules/database"
  name_prefix         = local.name_prefix
  private_subnet_ids  = module.network.private_subnet_ids
  security_group_id   = module.security.rds_sg_id
  kms_key_arn         = aws_kms_key.this.arn
  multi_az            = var.multi_az
  deletion_protection = var.deletion_protection
  tags                = var.tags
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix
  kms_key_arn = aws_kms_key.this.arn
  tags        = var.tags
}

module "rag" {
  source            = "../../modules/rag"
  name_prefix       = local.name_prefix
  private_subnet_id = module.network.private_subnet_ids[0]
  security_group_id = module.security.rag_sg_id
  # 100GB: the instance only holds the OS/CUDA image + model weights, not
  # matter documents (those live in S3/Postgres) - not driven by matter
  # data volume at all.
  root_volume_gb = 100
  tags           = var.tags
}

module "cicd" {
  source      = "../../modules/cicd"
  name_prefix = local.name_prefix
  kms_key_arn = aws_kms_key.this.arn
  tags        = var.tags
}

resource "aws_secretsmanager_secret" "auth0_mgmt_client_secret" {
  name       = "${local.name_prefix}/auth0-mgmt-client-secret"
  kms_key_id = aws_kms_key.this.arn
  tags       = var.tags
}

resource "aws_secretsmanager_secret_version" "auth0_mgmt_client_secret" {
  secret_id     = aws_secretsmanager_secret.auth0_mgmt_client_secret.id
  secret_string = var.auth0_mgmt_client_secret
}

module "compute" {
  source = "../../modules/compute"

  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  private_subnet_ids    = module.network.private_subnet_ids
  alb_sg_id             = module.security.alb_sg_id
  api_sg_id             = module.security.api_sg_id
  worker_sg_id          = module.security.worker_sg_id
  repository_bucket_arn = module.storage.repository_bucket_arn
  acm_certificate_arn   = var.acm_certificate_arn
  kms_key_arn           = aws_kms_key.this.arn

  api_image    = var.api_image
  worker_image = var.worker_image

  # Pilot-scale right-sizing (~10GB/matter) - Fargate's minimum memory tier
  # for each CPU allocation, single task each. No redundancy during
  # deploys/failures, acceptable for this dev/pilot environment.
  api_desired_count    = 1
  api_min_count        = 1
  api_max_count        = 4
  task_cpu             = 512
  task_memory          = 1024
  worker_desired_count = 1
  worker_max_count     = 4
  worker_task_cpu      = 1024
  worker_task_memory   = 2048

  environment_secrets = {
    DATABASE_URL             = module.database.database_url_secret_arn
    AUTH0_MGMT_CLIENT_SECRET = aws_secretsmanager_secret.auth0_mgmt_client_secret.arn
  }

  environment_plain = {
    PORT                       = "4520"
    DOCUMENT_STORE             = "s3"
    S3_BUCKET                  = module.storage.repository_bucket_name
    AWS_REGION                 = var.aws_region
    AUTH0_DOMAIN               = var.auth0_domain
    AUTH0_AUDIENCE             = var.auth0_audience
    AUTH0_MGMT_CLIENT_ID       = var.auth0_mgmt_client_id
    AUTH0_PLATFORM_ADMIN_CLAIM = var.auth0_platform_admin_claim
    OLLAMA_BASE_URL            = module.rag.ollama_base_url
    OLLAMA_EMBED_MODEL         = "nomic-embed-text"
    OLLAMA_GENERATE_MODEL      = "llama3.1:8b"
  }

  tags = var.tags
}

module "cdn" {
  source                  = "../../modules/cdn"
  name_prefix             = local.name_prefix
  spa_domain_name         = var.spa_domain_name
  spa_acm_certificate_arn = var.spa_acm_certificate_arn
  api_origin_domain_name  = module.compute.alb_dns_name
  tags                    = var.tags
}
