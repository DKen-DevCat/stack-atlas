resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = "{}"
}

resource "aws_cloudwatch_log_group" "api" {
  name = "/aws/lambda/${var.name}-api"
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name}-api"
  role          = aws_iam_role.api.arn
  package_type  = "Image"
  image_uri     = var.image_uri

  environment {
    variables = {
      DB_SECRET_ARN = var.db_secret_arn
      STAGE         = "dev"
    }
  }

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = []
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}
