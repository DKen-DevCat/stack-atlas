resource "aws_ecr_repository" "app" {
  name = "${var.name_prefix}-app"
}

module "network" {
  source      = "../../modules/network"
  name_prefix = var.name_prefix
}

module "aurora" {
  source      = "../../modules/aurora"
  name_prefix = var.name_prefix
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.private_subnet_ids
}

module "cognito" {
  source      = "../../modules/cognito"
  name_prefix = var.name_prefix
}

module "lambda_api" {
  source         = "../../modules/lambda-api"
  name_prefix    = var.name_prefix
  db_secret_arn  = module.aurora.secret_arn
  cognito_issuer = module.cognito.issuer
  image_uri      = "${aws_ecr_repository.app.repository_url}:api"
  allowed_origin = var.allowed_origin
}

module "static_site" {
  source      = "../../modules/static-site"
  name_prefix = var.name_prefix
}

module "scheduler_notify" {
  source      = "../../modules/scheduler-notify"
  name_prefix = var.name_prefix
  lambda_arn  = module.lambda_api.notify_arn
}
