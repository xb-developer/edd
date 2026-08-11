variable "name_prefix" {
  type = string
}

variable "private_subnet_id" {
  description = "Single private subnet to run the RAG instance in - no HA/autoscaling for this first pass, matching pilot-scale sizing guidance elsewhere in this plan."
  type        = string
}

variable "security_group_id" {
  description = "The existing rag security group (modules/security) - no public ingress, reachable only from the API and worker security groups."
  type        = string
}

variable "instance_type" {
  description = "g4dn.xlarge is the cheapest real NVIDIA GPU instance class - one T4 GPU, enough for nomic-embed-text + llama3.1:8b at pilot query volume."
  type        = string
  default     = "g4dn.xlarge"
}

variable "root_volume_gb" {
  description = "The Deep Learning base AMI alone needs significant space, plus model weights on top - default EBS root volumes are too small."
  type        = number
  default     = 150
}

variable "embed_model" {
  type    = string
  default = "nomic-embed-text"
}

variable "generate_model" {
  type    = string
  default = "llama3.1:8b"
}

variable "tags" {
  type    = map(string)
  default = {}
}
