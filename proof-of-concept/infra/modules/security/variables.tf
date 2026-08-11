variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "api_container_port" {
  description = "Port the Backend API container listens on (matches cloud-backend's PORT)."
  type        = number
  default     = 4520
}

variable "rag_port" {
  description = "Port the RAG/LLM service listens on (Ollama's default, or whatever the eventual GPU service uses)."
  type        = number
  default     = 11434
}

variable "tags" {
  type    = map(string)
  default = {}
}
