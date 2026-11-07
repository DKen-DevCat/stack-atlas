output "private_subnet_ids" {
  value = [aws_subnet.private.id]
}

output "lambda_sg_id" {
  value = aws_security_group.lambda.id
}
