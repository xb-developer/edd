output "repository_bucket_name" {
  value = aws_s3_bucket.repository.bucket
}

output "repository_bucket_arn" {
  value = aws_s3_bucket.repository.arn
}
