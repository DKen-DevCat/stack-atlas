output "api_url" {
  value = module.lambda_api.api_url
}

output "site_bucket" {
  value = module.static_site.bucket_name
}

output "distribution_id" {
  value = module.static_site.distribution_id
}
