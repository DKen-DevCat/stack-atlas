# 合成フィクスチャ（stack-atlas のテスト用）。実在のシステムとは無関係。
locals {
  prefix = "demo-${var.env}"
}

module "network" {
  source = "../../modules/network"
  cidr   = "10.0.0.0/16"
}

module "db" {
  source     = "../../modules/db"
  name       = local.prefix
  subnet_ids = module.network.private_subnet_ids
}

module "lambda" {
  source        = "../../modules/lambda"
  name          = local.prefix
  db_secret_arn = module.db.secret_arn
  subnet_ids    = module.network.private_subnet_ids
  image_uri     = "${aws_ecr_repository.app.repository_url}:api"
}

module "site" {
  source  = "../../modules/static-site"
  name    = local.prefix
  api_url = module.lambda.function_url
}

module "remote_vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

resource "aws_ecr_repository" "app" {
  name = "${local.prefix}-app"
}
