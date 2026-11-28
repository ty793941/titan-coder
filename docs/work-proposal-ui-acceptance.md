# 工作提案正式界面：操作与验收

## 交付范围

将已有工作提案后端接入正式项目经理对话。用户描述一个业务目标，由模型生成结构化工作名称、目标、成功标准、优先级和问题确认全文；用户审阅保存版本后显式确认，后端原子创建真实任务和待审批工件，再通过原审批链审阅和推进。

本轮复用既有 RuntimeAdapter、ConversationDaemon、本机历史、CSRF、提案确认、任务和工件服务，不新增数据库表、模型直连或自动执行能力，也没有调整正式产品主导航。普通问答保持原只读行为。

## 操作步骤

1. 执行 `pnpm ui`，打开正式项目工作台，选择项目并点击“询问项目经理”。
2. 在“本次意图”选择“生成工作提案”，选择已配置的 Codex 或 Qwen，描述希望达成的业务结果。
3. 点击“生成工作提案”。此操作调用模型，可能产生费用；打开历史、阅读、确认和刷新不调用模型。
4. 完成后阅读提案名称、目标、成功标准、优先级和问题确认全文。需要修改时补充要求，重新生成；不能修改页面正文后冒充原保存版本。
5. 点击“确认建立目标与草稿”，建立一个 `questions/active` 任务和一个 `questions/draft/pending` 工件。
6. “查看工作目标”进入现有任务页面；“进入草稿审批”进入正式决策详情，读取和校验正文后可以明确批准，再单独推进阶段。

确认保存不代表批准，也不会创建 Session、Run 或执行作业。未经用户明确启动，不调用代码执行或文件工具。

## 恢复与错误

| 场景 | 行为 |
| --- | --- |
| 普通问答 | 请求不带提案 mode，不展示确认卡 |
| 未确认的合法提案 | 只保存在本机对话历史，不提前创建任务 |
| 确认期间重复点击 | 按钮禁用，只发出一次确认请求 |
| 确认已成功，但响应丢失 | 保留相同来源和 checksum，再次确认返回原任务及工件 |
| 刷新或重新打开历史 | 恢复保存的提案，可再次确认同一来源，后端去重 |
| 版本冲突 | 禁止继续提交旧版本，提示重新读取历史并审阅 |
| 模型输出非法、失败或取消 | 无可确认提案，不自动重试模型调用 |
| 保存后资料读取失败 | 明确提示“已保存，但资料尚未同步”，保留提案及结果，稍后重试查看 |
| 后台刷新与确认并发 | 等待当前读取并补读最新事实后再导航 |
| 等待资料期间离开项目 | 迟到刷新不覆盖用户的新位置 |
| 提案已被审批或任务已推进 | 依据当前事实进入审批或交付物，不把初次创建快照误报为当前状态 |

本机历史保留最近 40 回合。未确认提案超出保留窗口时不保证恢复；已确认任务由控制面保存。界面中的“已保存”结果只表示当前确认响应，刷新后可安全重放确认获取原对象。

## 请求与安全边界

- 生成沿用 `/local-api/projects/:projectId/conversation/turns`，增加 `mode=work-proposal`。
- 确认仅通过 `/local-api/projects/:projectId/conversation/accept`，请求严格为 `{ turnId, proposalChecksum, confirmed: true }`，使用同源 JSON 和 `X-Titan-CSRF`。
- 不在浏览器提交替换正文、模型密钥、URL、工具权限、批准状态或目标 ID。后端从私有历史复核保存的完整版本。
- 卡片以文本插值展示内容，不渲染模型 HTML。未知错误使用固定提示，不展示后端响应原文。
- Codex 仍通过原生 App Server；模型生成工具集为空。模型输出的任务建议不会自行获得权限。

## 自动化验证

验证环境为 Node.js 24.22.3、真实本机 Chrome、PostgreSQL、独立控制面与本机网关。模型使用明确标记“离线验收”的 RuntimeAdapter 夹具，未调用付费 Provider。

| 门禁 | 结果 |
| --- | --- |
| 全仓无缓存构建、类型和静态检查 | 33/33 任务通过 |
| 前端完整回归，含网关与真实 IPC | 85/85，通过；无失败、无跳过 |
| 本轮新增用例 | 16 项，覆盖请求、确认、恢复、模式与导航 |
| OpenAPI 一致性及差异格式检查 | 通过 |
| 独立只读代码评审 | `approve`，无剩余 P1/P2 |
| 真实浏览器闭环 | 通过；375、768、1024、1440 无页面横向溢出，`pageerror=0` |

先红后绿证据包括：缺少确认请求/组件、未接入生成模式/历史卡片、后台刷新吞掉新事实、同步失败错误导航及离开页面后迟到导航。评审发现的同步失败入口问题已补充 App 集成回归后修复。

浏览器通过真实 API 创建专用项目，然后验证：生成后无任务 → 模拟丢弃一次已成功的确认响应 → 重试只有一任务一工件 → 草稿未批准且无执行 Session → 刷新历史再次确认仍为同 ID → 正式正文审阅、批准和推进到研究 → 非法输出/取消不产生新卡片或任务。

浏览器会保留专用开发项目作为可追溯证据，不清空用户数据。夹具历史在隔离目录 `.titan/manager-browser-history/`，不会伪装为真实模型回复出现在正式私有对话历史。

```bash
pnpm exec turbo run build typecheck lint --force --output-logs=errors-only
pnpm --filter @titan/web-console exec vitest run --maxWorkers=1 --testTimeout=30000
node packages/contracts/openapi/generate.mjs --check
```

浏览器脚本 `apps/web-console/test/work-proposal-browser-smoke.py`，服务夹具 `apps/web-console/test/fixtures/manager-server.mjs`，使用 5177/3341 端口。需要本机 Chrome 和已安装 Playwright 的 Python：

```bash
python3 /Users/zhanghai/.claude/skills/webapp-testing/scripts/with_server.py \
  --server "node apps/web-console/test/fixtures/manager-server.mjs" --port 5177 -- \
  /tmp/titan-product-browser-env/bin/python apps/web-console/test/work-proposal-browser-smoke.py
```

截图为 `work-proposal-375.png`、`work-proposal-768.png`、`work-proposal-1024.png`、`work-proposal-1440.png`，位于本次任务工件目录。

## 后续边界

本轮仅把一个业务目标落实为工作目标和问题确认草稿。研究、设计、结构和计划的自动生成，以及获批准后的多 Agent 执行编排，仍须后续切片实现。现有人工审批、版本校验、权限和执行授权继续有效。
