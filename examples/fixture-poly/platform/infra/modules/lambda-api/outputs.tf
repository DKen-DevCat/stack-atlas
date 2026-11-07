output "api_url" {
  value = aws_lambda_function_url.api.function_url
}

output "notify_arn" {
  value = aws_lambda_function.notify.arn
}
