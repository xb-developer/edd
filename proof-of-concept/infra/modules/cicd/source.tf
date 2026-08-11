# Holds the zipped build context CodeBuild builds from (source.zip is
# uploaded out-of-band, see the deployment notes - there's no git repo for
# this project yet, so this stands in for what a GitHub/CodeCommit source
# would normally provide). Versioned so a bad upload doesn't destroy the
# last known-good source.

resource "aws_s3_bucket" "build_source" {
  bucket = "${var.name_prefix}-build-source"
  tags   = var.tags
}

resource "aws_s3_bucket_versioning" "build_source" {
  bucket = aws_s3_bucket.build_source.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "build_source" {
  bucket                  = aws_s3_bucket.build_source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build_source" {
  bucket = aws_s3_bucket.build_source.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}
