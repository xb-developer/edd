# Web SPA hosting (Section 3.1/8.1): the client build is static files,
# served via CloudFront with Origin Access Control — the S3 bucket itself
# stays private, nothing reaches it directly.
#
# The API is reachable at the same hostname/port via a second CloudFront
# origin (the ALB) and a /api/* path-based behavior — this is what lets the
# SPA call the backend over HTTPS without a browser mixed-content block,
# since the ALB itself is still plain HTTP (Section 8.1's direct-domain
# ACM cert on the ALB is a later step, not needed while CloudFront sits in
# front of it).

resource "aws_s3_bucket" "spa" {
  bucket = "${var.name_prefix}-spa"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-spa" })
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket                  = aws_s3_bucket.spa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "spa" {
  bucket = aws_s3_bucket.spa.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.name_prefix}-spa-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "spa" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${var.name_prefix} EDD Workbench SPA"
  aliases             = [var.spa_domain_name]

  origin {
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_id                = "spa-s3-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  origin {
    domain_name = var.api_origin_domain_name
    origin_id   = "api-alb-origin"
    custom_origin_config {
      # http-only: matches the ALB's existing plain-HTTP listener. TLS is
      # terminated at the CloudFront edge (viewer_certificate below); this
      # leg stays inside AWS's network. Switching this origin to https-only
      # would need the ALB's own cert to cover its raw *.elb.amazonaws.com
      # name, which stage.xbundle.com's cert doesn't.
      origin_protocol_policy = "http-only"
      http_port              = 80
      https_port             = 443
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "spa-s3-origin"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # Dynamic, per-user API responses - never cached, and the Authorization
  # bearer token + JSON body must reach the origin untouched.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "api-alb-origin"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Accept"]
      cookies {
        forward = "all"
      }
    }
  }

  # No custom_error_response 403/404->index.html rewrite here deliberately -
  # this app has no client-side URL routing (no react-router, single "/"
  # entry point, navigation is all local React state), so that rewrite was
  # never actually needed for SPA deep-linking. It's also actively harmful
  # now that this distribution also serves the API on /api/*: it's a
  # distribution-wide setting, not scoped to the S3 origin/behavior, so it
  # was silently replacing real API 403/404 JSON responses (e.g.
  # "no_matching_account") with the SPA's index.html - found via a real
  # "Unexpected token '<'" JSON-parse error, not by inspection.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.spa_acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.spa.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.spa.arn }
      }
    }]
  })
}
