data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "secrets" {
  name = "${var.name_prefix}-secrets"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.db_secret_arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name_prefix}-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "gmail_webhook" {
  name              = "/aws/lambda/${var.name_prefix}-gmail-webhook"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "notify" {
  name              = "/aws/lambda/${var.name_prefix}-notify"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name_prefix}-api"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = 15

  environment {
    variables = {
      DB_SECRET_ARN  = var.db_secret_arn
      COGNITO_ISSUER = var.cognito_issuer
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = [var.allowed_origin]
    allow_methods = ["GET", "POST", "DELETE"]
    allow_headers = ["authorization", "content-type"]
  }
}

resource "aws_lambda_function" "gmail_webhook" {
  function_name = "${var.name_prefix}-gmail-webhook"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = 30

  environment {
    variables = {
      DB_SECRET_ARN = var.db_secret_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.gmail_webhook]
}

resource "aws_lambda_function_url" "gmail_webhook" {
  function_name      = aws_lambda_function.gmail_webhook.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_function" "notify" {
  function_name = "${var.name_prefix}-notify"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = 60

  environment {
    variables = {
      DB_SECRET_ARN = var.db_secret_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.notify]
}
