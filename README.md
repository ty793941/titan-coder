# Titan Coder

Titan Coder 是一个面向产品和研发交付的 Agent 工作台。第一阶段先交付无 UI 的本机 Headless MVP，通过 REST API、CLI 和 SSE 验证 `Project → Task → Session → Run → Artifact` 闭环。

## 当前阶段

Phase 1 只覆盖本机执行、Codex/Qwen Runtime Adapter 契约、PostgreSQL 事实存储、Tool/Permission/Hook、Git Worktree、Daemon 和失败恢复。Web UI、云端 Session、多人协作、外部系统与其他模型 Provider 留到后续阶段。

## 本地开发

要求 Node.js 22 LTS 和 pnpm 10.34.5。

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

本机基础设施配置在 `infra/docker-compose.yml`。数据库脚本位于 `database/schema.sql` 和 `database/init-data.sql`。

## 目录

- `apps/`：Control Plane、Agent Runtime、Daemon 和 CLI 应用。
- `packages/`：共享契约、领域模型、Agent Core、Daemon 协议和观测能力。
- `docs/`：产品规格、阶段路线、设计文档和实施计划。
