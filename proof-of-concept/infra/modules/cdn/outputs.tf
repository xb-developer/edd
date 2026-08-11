output "spa_bucket_name" {
  value = aws_s3_bucket.spa.bucket
}

output "spa_cloudfront_domain" {
  value = aws_cloudfront_distribution.spa.domain_name
}

output "spa_distribution_id" {
  value = aws_cloudfront_distribution.spa.id
}
