variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "name_prefix" {
  type    = string
  default = "expense-dev"
}

variable "allowed_origin" {
  type    = string
  default = "https://expenses.example.com"
}
