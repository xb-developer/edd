output "private_ip" {
  value = aws_instance.ollama.private_ip
}

output "ollama_base_url" {
  description = "Feed this straight into OLLAMA_BASE_URL for the API and worker tasks."
  value       = "http://${aws_instance.ollama.private_ip}:${local.ollama_port}"
}

output "instance_id" {
  value = aws_instance.ollama.id
}
