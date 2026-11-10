resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.name_prefix}-db"
  vpc_id = var.vpc_id
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.name_prefix}/db"
}

resource "aws_rds_cluster" "this" {
  cluster_identifier     = "${var.name_prefix}-cluster"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  database_name          = "expenses"
  master_username        = "app"
  manage_master_user_password = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2
  }
}

resource "aws_rds_cluster_instance" "this" {
  identifier         = "${var.name_prefix}-instance-1"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
}
