variable "aws_region" {
  type    = string
  default = "eu-west-2" # London — UK legal-sector data-residency default per Section 14; override per client if needed
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "azs" {
  type    = list(string)
  default = ["eu-west-2a", "eu-west-2b"]
}

variable "api_image" {
  description = "Full image URI for the Cloud Backend API (built from cloud-backend/, e.g. an ECR image tag). No default on purpose — this plan doesn't own the CI/CD pipeline that publishes it (Section 9)."
  type        = string
}

variable "worker_image" {
  description = "Full image URI for the extraction/embedding worker (same codebase, cloud-backend/src/worker.ts as entrypoint)."
  type        = string
}

variable "auth0_domain" {
  description = "Auth0 tenant domain — see cloud-backend/docs/auth0-setup.md."
  type        = string
}

variable "auth0_audience" {
  type = string
}

variable "auth0_platform_admin_claim" {
  type    = string
  default = "https://edd-workbench.example.com/platform_admin"
}

variable "auth0_mgmt_client_id" {
  type = string
}

variable "auth0_mgmt_client_secret" {
  description = "Secret value for the Auth0 Management API M2M app. Supply via TF_VAR_auth0_mgmt_client_secret or a gitignored *.auto.tfvars — never commit this."
  type        = string
  sensitive   = true
}


# Section 14's "third-party LLM provider vs. self-hosted model" decision is
# resolved: self-hosted only, by explicit instruction - no external API
# calls, no document text or embeddings leave this environment ever. See
# module.rag - it provisions the GPU instance and computes OLLAMA_BASE_URL
# directly, so there's no variable for it here anymore.

variable "acm_certificate_arn" {
  description = "ACM cert for the ALB's HTTPS listener. Null until a real domain exists (Section 8.1). Unused for now - the ALB stays plain-HTTP behind CloudFront, which terminates TLS at the edge instead (see module.cdn)."
  type        = string
  default     = null
}

variable "spa_domain_name" {
  description = "Real hostname the SPA (and, via /api/*, the backend API) is served at."
  type        = string
}

variable "spa_acm_certificate_arn" {
  description = "ACM cert ARN in us-east-1 (CloudFront requirement) covering spa_domain_name."
  type        = string
}

variable "deletion_protection" {
  description = "RDS deletion protection + final snapshot. Off by default in dev so the environment is easy to tear down; should be true for staging/production."
  type        = bool
  default     = false
}

variable "multi_az" {
  description = "RDS Multi-AZ. Off by default in dev to save cost; should be true for staging/production per Section 8.1."
  type        = bool
  default     = false
}

variable "tags" {
  type = map(string)
  default = {
    Project = "edd-workbench"
  }
}
