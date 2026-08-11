# Self-hosted RAG/LLM compute (Section 3.4/8.1), resolving Section 14's
# "third-party LLM provider vs. self-hosted model" decision: self-hosted,
# by explicit instruction - no external API calls, no document text or
# embeddings ever leave this environment. Private subnet, no public IP, the
# rag security group (modules/security) only accepts inbound traffic from
# the API and worker security groups - nothing else can reach it, and it
# has no reason to initiate outbound connections after first-boot setup.

data "aws_ami" "deep_learning" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)*"]
  }
}

locals {
  ollama_port = 11434
}

resource "aws_instance" "ollama" {
  ami                    = data.aws_ami.deep_learning.id
  instance_type          = var.instance_type
  subnet_id              = var.private_subnet_id
  vpc_security_group_ids = [var.security_group_id]

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    ollama_port    = local.ollama_port
    embed_model    = var.embed_model
    generate_model = var.generate_model
  })

  # Model pulls happen once at boot and can take a while on first launch;
  # replacing the instance shouldn't force re-pulling into a fresh volume
  # unless something about the launch config actually changed.
  lifecycle {
    create_before_destroy = false
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-ollama" })
}
