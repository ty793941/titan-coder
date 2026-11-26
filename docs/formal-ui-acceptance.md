# 正式产品 UI V1 验收记录

## 验收范围

本轮验证面向项目负责人，确认默认入口是正式产品的 Decision Desk，而不是开发验收控制台。正式入口使用根路径，开发验收控制台保留在 `#/acceptance`。

正式产品包含：

- “我的决策”首页。
- 项目空间。
- 决策详情和真实 Artifact 批准、阶段推进接口。
- 交付物列表和项目活动摘要。
- 响应式侧栏、空状态、加载状态、错误恢复和键盘焦点。
- 正式界面中的项目创建、工作目标创建、阶段资料编辑和执行详情入口。

## 安全边界

- 首页只显示 Project、Task、Artifact、Session 和 Run 的安全摘要。
- 页面不显示 API Key、凭证正文、Prompt、完整 Checkpoint、原始 Tool 输出或未经处理的 HTTP 错误正文。
- 决策 ID 由稳定对象 ID 组成，刷新不会创建重复事实。
- 审批和阶段推进沿用现有版本校验、认证和幂等接口。
- 验收 UI 的环境、凭证、Daemon 和原始事件入口不进入正式产品主导航。

## 已执行验证

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @titan/web-console typecheck` | 通过 |
| `pnpm --filter @titan/web-console exec vitest run --maxWorkers=1` | 53/53 通过，无失败或跳过 |
| `pnpm --filter @titan/web-console build` | 通过 |
| `git diff --check` | 通过 |
| 全仓无缓存构建、类型和静态检查 | 33/33 任务通过 |
| OpenAPI 一致性 | 通过 |
| 最终只读代码评审 | `approve`，无未解决 P1/P2 |
| 正式路由、决策适配、数据加载和组件测试 | 21 项通过，另新增 1 项统一 API 错误脱敏回归 |

## 浏览器验收

浏览器脚本为 `apps/web-console/test/product-browser-smoke.py`。已在 Node.js 24.22.3、本机 Chrome、真实 PostgreSQL 和独立 Control Plane 上执行。覆盖 375px、768px、1024px、1440px 宽度，无页面横向溢出，`pageerror=0`。没有调用付费模型。

执行命令：

```bash
uv venv /tmp/titan-product-browser-env
uv pip install --python /tmp/titan-product-browser-env/bin/python playwright
TITAN_UI_PORT=5175 TITAN_CONTROL_PLANE_PORT=3303 \
python3 /Users/zhanghai/.claude/skills/webapp-testing/scripts/with_server.py \
  --server "node apps/web-console/server/start.mjs" \
  --port 5175 -- /tmp/titan-product-browser-env/bin/python \
  apps/web-console/test/product-browser-smoke.py --base-url http://127.0.0.1:5175
```

实际完成的流程为：创建项目 → 添加工作目标与成功标准 → 创建真实问题确认工件 → 从决策收件箱进入正文 → 校验并批准 → 从新决策推进到研究阶段 → 查看项目空间 → 展开交付物阅读正文 → 验证移动导航关闭和减少动画模式。

浏览器测试会在本机开发数据库创建专用项目和目标，保留可追溯记录，不覆盖或清理用户项目。截图保存为 `formal-inbox-375.png`、`formal-inbox-768.png`、`formal-inbox-1024.png`、`formal-inbox-1440.png`、`formal-decision.png`、`formal-project.png`。

正文审阅发现的批准后组件卸载竞态已修复：先发出完成通知并导航，再刷新决策队列。API 未知错误在统一边界映射为固定用户提示；折叠的交付物不会请求正文，展开目标项后才读取。

## 入口说明

- 执行 `pnpm ui` 后正式产品：`http://127.0.0.1:5173/#/`。
- 开发验收控制台：`http://127.0.0.1:5173/#/acceptance`。
- 本轮独立成品预览使用 `TITAN_UI_PORT=5175`、`TITAN_CONTROL_PLANE_PORT=3303`，避免覆盖已有进程。

## 当前能力边界

- 项目经理入口当前提供来自真实任务状态的摘要和新工作目标入口，尚不提供实时模型对话。页面明确说明这一点，不生成模型回复或虚构进展。
- 项目关注状态来自现有决策、任务和运行记录，没有交付日期基线时不据此推断按期交付概率。
- 继续复用本机网关及密钥链安全边界，只绑定回环地址。本轮交付适用于本机单用户使用，不能直接用于公网多人部署。
