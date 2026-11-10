variable "name" {
  type = string
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}
