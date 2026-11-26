# 正式产品 UI V1 验收记录

## 验收范围

本轮验证面向项目负责人，确认默认入口是正式产品的 Decision Desk，而不是开发验收控制台。正式入口使用根路径，开发验收控制台保留在 `#/acceptance`。

正式产品包含：

- “我的决策”首页。
- 项目空间。
- 决策详情和真实 Artifact 批准、阶段推进接口。
- 交付物列表和项目活动摘要。
- 响应式侧栏、空状态、加载状态、错误恢复和键盘焦点。

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
| `pnpm --filter @titan/web-console test -- --maxWorkers=1` | 47/47 通过 |
| `pnpm --filter @titan/web-console build` | 通过 |
| `git diff --check` | 通过 |
| 正式路由、决策适配、数据加载和组件测试 | 16 项通过 |

## 浏览器验收

浏览器脚本为 `apps/web-console/test/product-browser-smoke.py`，覆盖 375px 和 1440px 宽度、正式首页标题、验收标签隔离、横向溢出和 Console Error。

执行命令：

```bash
python3 /Users/zhanghai/.claude/skills/webapp-testing/scripts/with_server.py \
  --server "pnpm --filter @titan/web-console dev" \
  --port 5174 -- python3 apps/web-console/test/product-browser-smoke.py
```

当前环境没有 Python `playwright` 模块，因此浏览器截图验收尚未执行；Vite 开发服务器启动和入口响应已通过 `curl` 检查。安装依赖后应重新执行上面的命令，并将实际截图路径和结果补入本节。

## 入口说明

- 正式产品：`http://127.0.0.1:5174/#/`
- 开发验收控制台：`http://127.0.0.1:5174/#/acceptance`
