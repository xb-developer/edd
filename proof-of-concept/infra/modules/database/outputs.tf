output "endpoint" {
  value = aws_db_instance.this.address
}

output "database_url_secret_arn" {
  description = "Secrets Manager ARN holding the full DATABASE_URL — inject into the ECS task definition, never hardcode it."
  value       = aws_secretsmanager_secret.database_url.arn
}
