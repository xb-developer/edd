output "api_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "worker_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "build_source_bucket" {
  value = aws_s3_bucket.build_source.bucket
}

output "codebuild_project_name" {
  value = aws_codebuild_project.build.name
}
