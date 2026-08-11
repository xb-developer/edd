# The Secure Document Repository (Section 3.3): every raw file uploaded to
# every matter lands here, key-prefixed per organization/matter (see
# cloud-backend/src/storage/documentKey()). Never public — the only access
# path is a presigned URL the Backend issues after checking matter/group
# access (cloud-backend/src/storage/s3Store.ts).

resource "aws_s3_bucket" "repository" {
  bucket = "${var.name_prefix}-document-repository"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-document-repository" })
}

resource "aws_s3_bucket_public_access_block" "repository" {
  bucket                  = aws_s3_bucket.repository.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "repository" {
  bucket = aws_s3_bucket.repository.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "repository" {
  bucket = aws_s3_bucket.repository.id
  versioning_configuration {
    status = "Enabled" # Section 11.2 — recovers an accidental overwrite/delete
  }
}

resource "aws_s3_bucket_ownership_controls" "repository" {
  bucket = aws_s3_bucket.repository.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
