resource "random_password" "db" {
  length = 32
}

resource "aws_db_subnet_group" "this" {
  subnet_ids = var.subnet_ids
}

resource "aws_rds_cluster" "this" {
  cluster_identifier   = "${var.name}-db"
  engine               = "aurora-postgresql"
  db_subnet_group_name = aws_db_subnet_group.this.name
  master_password      = random_password.db.result
}

resource "aws_rds_cluster_instance" "this" {
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.name}/db"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id     = aws_secretsmanager_secret.db.id
  secret_string = random_password.db.result
}

resource "aws_ssm_parameter" "endpoint" {
  name  = "/${var.name}/db/endpoint"
  type  = "String"
  value = aws_rds_cluster.this.endpoint
}
