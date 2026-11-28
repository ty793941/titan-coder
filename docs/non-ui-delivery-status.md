# 非 UI 能力交付状态与后续顺序

## 结论

除去 UI，全部工程阶段仍未完成。Phase 1 本机 MVP 已有工程验证，Phase 2A/2B 完成本机 Docker Cloud Worker 与 Temporal 编排，但 Phase 2 的跨主机与生产能力、Phase 3 完整多人协作、Phase 4、Phase 5 仍有明确缺口。

本文件以 `docs/implementation-roadmap.md` 的工程阶段编号为准，不与 `docs/product-spec.md` 的产品生命周期编号混用。部署或付费模型外部验收没有执行时，不以本机离线测试替代。

## 阶段状态

| 工程阶段 | 已实现并记录证据 | 未完成的非 UI 内容 |
| --- | --- | --- |
| Phase 1 本机 Headless MVP | Codex App Server、Qwen、Task/Session/Run/Artifact、Daemon、Outbox、Checkpoint、受限工具、QRSPI 门禁 | 真实付费 Provider 推理仍需可用账号、URL/Key 和显式运行验收；不等同于完整 s01–s17 高级 Runtime |
| Phase 2 云端与持久执行 | 本机 Docker Cloud Worker、Snapshot Handoff、Secret Lease、恢复/fencing、Temporal Worker、有限 Schedule | 跨主机 Git/Snapshot 传输、对象存储、生产 Secret Broker、定时 cloud Session、生产调度 |
| Phase 2C 项目经理后端 | 只读本机问答及私有历史、结构化工作提案、确认后原子创建 Task 和待审批 questions Artifact | 从目标到完整 QRSPI 草稿的多角色编排、预算与权限约束下的可执行项目经理 |
| Phase 3 协作 | 本轮新增可信管理端成员引用、可选 WorkItem、分配、串行/并行评审、交接、个人 Inbox | 真实成员身份与项目权限、评论/提及、通知、Presence、多人评审/职责分离、工作项依赖/调度、返工流程 |
| Phase 4 模型和集成 | Codex/Qwen 现有 Adapter 可作为扩展基础 | Claude Agent SDK、Gemini、DeepSeek、智谱、模型路由/健康/成本/降级、外部连接器/绑定/增量同步/冲突队列 |
| Phase 5 自动化与规模化 | Temporal Timer/Continue-As-New 与基础 Schedule 可复用 | Agent Teams、动态 Workflow/Journal、完整 Cron、Skill/Plugin Registry、评估回归、跨区调度、Kubernetes、企业身份与治理 |

## 继续实施顺序

1. **真实成员身份与项目权限**：把身份、成员引用、角色和审批主体分开，保护已有读写 API；取消用任意请求字段表达“当前用户”的可能。只在独立身份到位后开放外部成员个人动作。
2. **任务级协作闭环**：在权限基础上接入评论/提及、评审变更工作项、任务依赖、交接上下文和通知收敛；工作项变为 Task 下真正可拆分的调度单元。
3. **可执行项目经理**：基于已批准工件和权限快照，为研究、方案、计划、开发、测试和评审分派受控角色，持久化输入、输出、成本、取消和恢复点；禁止绕过批准直接执行。
4. **补齐跨主机执行**：先冻结传输和对象存储契约，再提供本机多进程验收、云端 Broker 适配和远端部署验收，不把共享宿主目录称为远程传输。
5. **模型与外部管理系统**：按提供方/连接器分别实现和验收，保留适配器隔离；真实连接验证需要目标系统、账户授权和凭证，不在文档中伪造已接通。
6. **生产和高级自动化**：在前述闭环上扩展 Teams、完整调度、插件分发、评估、集群和企业治理。生产部署、权限变更和外部写入仍按项目高风险门禁执行。

每个子项目须单独具备契约、持久状态、权限、失败恢复、测试和只读评审证据。UI 重构、用户原型草稿及未跟踪文件不属于本轮后端任务，保持原样。

## 本轮新增交付

协作基础接口和数据库事务说明见 [协作后端验收](collaboration-backend-acceptance.md)。新能力采用既有 PostgreSQL、NestJS、Kysely、Zod、EventsService 和 IdempotencyService，不新增模拟 UI 或执行假任务，不把有限本机身份边界描述成完整多人系统。
