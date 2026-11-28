# 工作提案正式界面实施计划

## 目标与设计

面向项目负责人，在既有项目经理对话中完成描述目标、生成提案、阅读问题确认全文、显式确认建立任务和草稿、进入原审批链。当前后端已经具备严格提案契约、私有历史恢复、checksum 确认、同来源去重和原子创建，本轮不新增数据库或重复接口。

采用独立生成模式和不可变提案卡。普通问答保持原行为；生成请求增加 `mode=work-proposal`。卡片显示工作名称、目标、成功标准、优先级、问题确认正文和“尚未保存/已保存”状态。点击“确认建立目标与草稿”只提交 `{ turnId, proposalChecksum, confirmed: true }`，不提交可替换的正文、项目身份或执行参数。确认不是批准。成功后刷新项目数据，可查看新任务，或直接进入新工件的正式审阅页。

不采用模型生成后自动保存，因为这会跳过用户审阅；不采用前端分别创建 Task 和 Artifact，因为不能保证原子性与去重。模型输出非法、失败或取消时无确认入口；网络失败保留相同来源以便安全重试；409 提示重新读取历史。刷新后卡片可以重新确认同一版本，后端返回原任务与工件，不能宣称本地按钮状态是持久业务事实。

## 文件与复用

- 修改 `apps/web-console/src/api.ts`：增加本机 accept 请求和返回类型，复用 `localPost` 与 CSRF。
- 新增 `apps/web-console/src/components/product/WorkProposalCard.vue`：只负责提案审阅、显式确认、错误与结果入口。
- 修改 `apps/web-console/src/components/product/ManagerConversation.vue`：生成模式、历史卡片、失败恢复、结果事件。
- 修改 `apps/web-console/src/App.vue`：确认后刷新事实、任务及正式审批导航。
- 修改 `apps/web-console/src/product/errors.ts`：固定提案冲突和服务不可用文案。
- 新增 `apps/web-console/test/work-proposal-ui.test.ts`：确认、校验、重试、历史和模式边界。
- 修改 `apps/web-console/test/api.test.ts`：确认路径、仅三字段、CSRF 测试。
- 扩展 `apps/web-console/test/fixtures/manager-server.mjs`：离线结构化模型提案，继续使用真实 RuntimeAdapter、Daemon、网关和控制面。
- 新增 `apps/web-console/test/work-proposal-browser-smoke.py`：生成到真实审批的浏览器验收。
- 新增 `docs/work-proposal-ui-acceptance.md`，更新已有后端及路线说明。

## 任务一：客户端与确认卡

- [x] 先添加 HTTP 与组件测试，运行观察缺少方法/组件的失败。关键断言：

```ts
expect(received.body).toEqual({ turnId, proposalChecksum, confirmed: true });
expect(received.csrf).toBe('local-csrf');
expect(accept).not.toHaveBeenCalled(); // 仅挂载或展开不确认
expect(accept).toHaveBeenCalledWith(projectId, { turnId, proposalChecksum, confirmed: true }, 'local-csrf');
```

- [x] 实现 typed `api.acceptWorkProposal`，请求使用本机确认路径，不使用通用 `/api` 旁路。卡片用纯文本显示全文，不用 `v-html`；仅 completed 的 work-proposal 且存在 proposal/checksum 时渲染。确认期间禁止重复点击；失败保留来源不重新生成；成功发出 task/artifact 结果。
- [x] 运行 `pnpm --filter @titan/web-console exec vitest run test/api.test.ts test/work-proposal-ui.test.ts --maxWorkers=1`，验证转绿。

## 任务二：对话模式与正式导航

- [x] 添加模式测试：普通问答请求无 mode；生成模式带固定 mode；响应丢失时同内容同模式复用 requestId，切换模式更换 requestId；无凭证、运行中或历史读取失败时禁止发送。失败重编辑保留原 mode，不能意外退回问答。
- [x] 增加原生选择框“本次意图”，值为普通问答和生成工作提案；提交按钮与等待文案匹配模式。将提案卡作为独立组件接入历史，确认成功通知父页面刷新并保留当前对话；“查看工作目标”和“进入草稿审批”分别走既有 task/decision 路由。
- [x] 运行全部前端回归和 `typecheck`，不能破坏现有问答、取消、刷新恢复。

## 任务三：真实浏览器、评审与交付

- [x] 使用独立离线模型夹具生成严格结构化提案，正文明确标记为离线验收；使用真实 Control Plane/PostgreSQL 创建任务与待审批工件。
- [x] 浏览器验证生成前无任务；生成后未确认仍无任务；确认后只新增一任务一工件，未批准且无 Session/Run；刷新历史重复确认返回同 ID；进入正式审批阅读正文、批准、推进。验证取消/非法提案无确认入口和四种屏宽无溢出。
- [x] 使用 Node 24 执行全仓无缓存 `pnpm exec turbo run build typecheck lint --force --output-logs=errors-only`、全部前端测试及 OpenAPI 检查。
- [ ] 独立只读评审所有增量并修复 P1/P2；写中文验收证据，提交并代理推送至 `chore/initial-project`，检查本地远端一致，清理干净隔离工作树。保留用户未跟踪文档与原型。

本计划在当前会话执行；用户此前已明确后续默认同意，无需重复询问设计或执行授权。真实付费模型调用不在本次自动化验收范围内。
