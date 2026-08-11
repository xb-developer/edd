variable "name_prefix" {
  description = "Prefix applied to every resource name/tag in this module (e.g. \"edd-dev\")."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "azs" {
  description = "Availability zones to spread subnets across. Two is the minimum for RDS Multi-AZ and an HA ALB target group."
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway instead of one per AZ. Cheaper for dev/staging; use false in production for AZ-independent egress."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tags merged onto every resource."
  type        = map(string)
  default     = {}
}
