variable "name_prefix" {
  type = string
}

variable "spa_domain_name" {
  description = "Real hostname the SPA is served at (e.g. stage.xbundle.com). Must be covered by spa_acm_certificate_arn's SAN."
  type        = string
}

variable "spa_acm_certificate_arn" {
  description = "ACM cert ARN in us-east-1 (CloudFront requirement, regardless of what region everything else runs in) covering spa_domain_name."
  type        = string
}

variable "api_origin_domain_name" {
  description = "The ALB's DNS name - CloudFront routes /api/* here so the SPA and API share one hostname/port (443), avoiding a browser mixed-content block against a plain-HTTP ALB."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
