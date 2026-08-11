# RDS PostgreSQL, Multi-AZ — the primary database (Section 8.1), the same
# schema the cloud-backend app already targets locally via DATABASE_URL
# (organizations/users/groups/matters/documents/tags/chunks/jobs, all with
# RLS — see cloud-backend/migrations/).

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.private_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name_prefix}-db-subnet-group" })
}

resource "random_password" "master" {
  length  = 32
  special = false # avoid characters that need extra escaping in connection-string URLs
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false

  multi_az                = var.multi_az
  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "mon:04:30-mon:05:30"

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name_prefix}-postgres-final" : null

  # RLS relies on the app-role session variables — see migrations/001_init.sql
  # — this parameter group is a hook for tuning (e.g. log_min_duration_statement)
  # without needing to redeploy the instance.
  parameter_group_name = aws_db_parameter_group.this.name

  tags = merge(var.tags, { Name = "${var.name_prefix}-postgres" })
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name_prefix}-postgres-params"
  family = "postgres16"
  tags   = var.tags
}

resource "aws_secretsmanager_secret" "database_url" {
  name       = "${var.name_prefix}/database-url"
  kms_key_id = var.kms_key_arn
  tags       = var.tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://${var.master_username}:${random_password.master.result}@${aws_db_instance.this.address}:5432/${var.database_name}"
}
