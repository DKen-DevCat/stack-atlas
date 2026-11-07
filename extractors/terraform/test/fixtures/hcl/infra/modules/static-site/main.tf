resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-web"
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "index" {
  name    = "${var.name}-index"
  runtime = "cloudfront-js-2.0"
  code    = "function handler(event) { return event.request; }"
}

resource "aws_cloudfront_distribution" "site" {
  enabled = true

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = "api"
    domain_name = replace(replace(var.api_url, "https://", ""), "/", "")
  }

  default_cache_behavior {
    target_origin_id = "s3"
    cache_policy_id  = "658327ea-f89d-4fab-a63d-7f88639e58f6"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.index.arn
    }
  }

  ordered_cache_behavior {
    path_pattern     = "/api/*"
    target_origin_id = "api"
    cache_policy_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  }
}
