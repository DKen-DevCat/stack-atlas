variable "name_prefix" {
  type = string
}

variable "image_uri" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "cognito_issuer" {
  type = string
}

variable "allowed_origin" {
  type    = string
  default = "*"
}
