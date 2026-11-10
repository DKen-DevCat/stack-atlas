resource "aws_iam_role" "scheduler" {
  name = "${var.name_prefix}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "scheduler.amazonaws.com" }
    }]
  })
}

resource "aws_scheduler_schedule" "daily" {
  name                = "${var.name_prefix}-daily-notify"
  schedule_expression = "cron(0 21 * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.lambda_arn
    role_arn = aws_iam_role.scheduler.arn
  }
}
