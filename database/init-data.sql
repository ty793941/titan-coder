INSERT INTO organization (id, name, status)
VALUES ('org_dev', 'Titan Development', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO project (id, organization_id, name, goal)
VALUES ('project_dev', 'org_dev', 'Titan Development Project', '验证本机 Headless 交付闭环')
ON CONFLICT (id) DO NOTHING;

INSERT INTO task (id, project_id, title, goal, acceptance_criteria, priority, stage, status)
VALUES (
  'task_dev',
  'project_dev',
  'Phase 1 development task',
  '验证 Task、Session 和 Run 的持久化关系',
  '["可以创建 Session", "可以重试 Run"]'::jsonb,
  'medium',
  'questions',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Daemon rows are registered by the local execution service and are not seeded.
-- execution_job 和 checkpoint 仅由执行事务创建，不初始化伪任务或凭证。
-- 旧 Daemon 无令牌摘要，需重新注册领取一次性令牌，不回填明文密钥。
-- Artifact 的 reference 和 metadata 由 schema.sql 提供，运行时写入时必须保持 URI 与元数据不可变。
-- 云端执行、Handoff 和短期 Secret Lease 仅由认证事务创建，不初始化凭证或伪租约。
-- 旧 Session 默认为 local，checkpoint.source_checkpoint_id 仅在跨环境导入时设置。
-- 后台任务、调度、触发和 Workflow 命令仅由授权事务创建，不种入启用定义或服务凭证。
-- 已有资源保持未绑定，直到独立 Workflow 身份在领取命令的同一事务中绑定。
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE execution_schedule ADD COLUMN IF NOT EXISTS worker_id TEXT;
