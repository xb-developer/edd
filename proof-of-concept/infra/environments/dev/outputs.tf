output "alb_dns_name" {
  description = "Point Route 53 (or your DNS provider) at this once a real domain exists."
  value       = module.compute.alb_dns_name
}

output "spa_cloudfront_domain" {
  value = module.cdn.spa_cloudfront_domain
}

# Needed to actually deploy the SPA build (`aws s3 sync` / `create-invalidation`,
# see CLOUD-DEPLOYMENT.md Step 5) — not previously exposed at the root, only
# reachable before this from inside module.cdn itself.
output "spa_bucket_name" {
  value = module.cdn.spa_bucket_name
}

output "spa_distribution_id" {
  value = module.cdn.spa_distribution_id
}

output "database_endpoint" {
  value = module.database.endpoint
}

output "repository_bucket_name" {
  value = module.storage.repository_bucket_name
}
