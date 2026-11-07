variable "name" {
  type = string
}

variable "image_uri" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}
