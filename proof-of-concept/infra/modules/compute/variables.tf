variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_sg_id" {
  type = string
}

variable "api_sg_id" {
  type = string
}

variable "worker_sg_id" {
  type = string
}

variable "api_container_port" {
  type    = number
  default = 4520
}

variable "api_image" {
  description = "Full image URI for the Cloud Backend API container (built from cloud-backend/). Required — no default, this plan doesn't own image publishing."
  type        = string
}

variable "worker_image" {
  description = "Full image URI for the extraction/embedding worker container (same codebase, cloud-backend/src/worker.ts as the entrypoint)."
  type        = string
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_min_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 10
}

variable "worker_desired_count" {
  description = "Deliberately conservative default — Section 12 says size this from real pilot volume, not a guess."
  type        = number
  default     = 2
}

variable "worker_max_count" {
  type    = number
  default = 8
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "worker_task_cpu" {
  description = "Workers get more CPU headroom by default — OCR is the dominant cost in extraction runtime (Section 1's benchmark)."
  type        = number
  default     = 2048
}

variable "worker_task_memory" {
  type    = number
  default = 4096
}

variable "acm_certificate_arn" {
  description = "ARN of an ACM cert for the ALB's HTTPS listener. Leave null until a real domain exists (Section 8.1's Route 53/ACM) — the ALB still works over plain HTTP in the meantime for initial bring-up."
  type        = string
  default     = null
}

variable "environment_secrets" {
  description = "Map of container env var name -> Secrets Manager secret ARN, injected into the API/worker tasks (e.g. DATABASE_URL, AUTH0_MGMT_CLIENT_SECRET). Never put real values directly in this map — only ARNs."
  type        = map(string)
  default     = {}
}

variable "kms_key_arn" {
  description = "KMS key the environment_secrets are encrypted under — the execution role needs kms:Decrypt on it, not just secretsmanager:GetSecretValue, or ECS can't actually start the task."
  type        = string
}

variable "repository_bucket_arn" {
  description = "Secure Document Repository bucket ARN (Section 3.3) — both API and worker task roles get read/write to it."
  type        = string
}

variable "environment_plain" {
  description = "Map of container env var name -> plain value for non-secret config (e.g. PORT, DOCUMENT_STORE, AUTH0_DOMAIN)."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
