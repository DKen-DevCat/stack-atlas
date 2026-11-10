output "secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "cluster_endpoint" {
  value = aws_rds_cluster.this.endpoint
}
