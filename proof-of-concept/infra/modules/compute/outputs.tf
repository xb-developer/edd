output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_task_role_arn" {
  value = aws_iam_role.api_task.arn
}

output "worker_task_role_arn" {
  value = aws_iam_role.worker_task.arn
}
