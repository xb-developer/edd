variable "name_prefix" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "kms_key_arn" {
  description = "KMS key used to encrypt storage and Multi-AZ standby/backups (Section 7.2)."
  type        = string
}

variable "engine_version" {
  type = string
  # 16.14 confirmed available via `aws rds describe-db-engine-versions` at
  # the time this was written — RDS doesn't offer every generic PostgreSQL
  # point release, so this can't just mirror upstream Postgres versioning.
  default = "16.14"
}

variable "instance_class" {
  description = "Deliberately small by default — Section 12 says size this from real pilot volume, not a guess. Bump post-pilot."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage_gb" {
  type    = number
  default = 50
}

variable "max_allocated_storage_gb" {
  description = "Ceiling for RDS storage autoscaling."
  type        = number
  default     = 500
}

variable "multi_az" {
  description = "Multi-AZ per Section 8.1. Only false for throwaway dev environments to save cost."
  type        = bool
  default     = true
}

variable "database_name" {
  type    = string
  default = "edd_cloud_backend"
}

variable "master_username" {
  type    = string
  default = "edd_admin"
}

variable "backup_retention_days" {
  type    = number
  default = 14
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
