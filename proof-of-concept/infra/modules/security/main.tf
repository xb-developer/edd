# Least-privilege security groups matching Section 8.1's private-subnet
# isolation: only the ALB is reachable from the internet; everything else is
# reachable only from the specific security group that legitimately needs it.

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Public ALB - the only ingress point from the internet."
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP from anywhere (redirected to HTTPS by the listener rule)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb-sg" })
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "api" {
  name_prefix = "${var.name_prefix}-api-"
  description = "Cloud Backend API (ECS) - reachable only from the ALB."
  vpc_id      = var.vpc_id

  ingress {
    description     = "From the ALB only"
    from_port       = var.api_container_port
    to_port         = var.api_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-api-sg" })
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  description = "Extraction/embedding worker fleet - no inbound traffic at all, it only pulls work."
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-worker-sg" })
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.name_prefix}-rds-"
  description = "Postgres - reachable only from the API and the worker fleet, never anything else."
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from the API"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
  ingress {
    description     = "Postgres from the workers"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.worker.id]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-rds-sg" })
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "rag" {
  name_prefix = "${var.name_prefix}-rag-"
  description = "RAG/LLM compute - no public ingress (Section 3.4/8.1); reachable only from the API."
  vpc_id      = var.vpc_id

  ingress {
    description     = "From the API only"
    from_port       = var.rag_port
    to_port         = var.rag_port
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
  ingress {
    description     = "From the worker fleet, for embedding calls during extraction"
    from_port       = var.rag_port
    to_port         = var.rag_port
    protocol        = "tcp"
    security_groups = [aws_security_group.worker.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-rag-sg" })
  lifecycle { create_before_destroy = true }
}
