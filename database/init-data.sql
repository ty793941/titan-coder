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
