# 本机 UI 验收与真实 Key 配置

> 用户要求新增人工验收 UI，本增量调整原 Phase 1 的无 UI 边界，只服务本机单用户验收。

## 启动

要求 Node.js 22、pnpm、Docker PostgreSQL。Codex 执行还要求本机 PATH 中存在 `codex`。

UI 也会检测 ChatGPT 应用随附的本机 Codex；如需指定其他原生程序，可在启动前设置本机环境变量 `TITAN_CODEX_BINARY=/absolute/path/to/codex`。该路径不来自任务或模型输入。

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d --wait postgres
pnpm ui
```

浏览器打开 `http://127.0.0.1:5173`。启动器先构建模块，再启动独立控制面 `127.0.0.1:3301` 和验收网关。默认数据库为开发 Compose 的 `postgresql://titan:titan@127.0.0.1:55432/titan`，可用 `DATABASE_URL` 覆盖。

已运行的 3000 端口 Headless 服务可以保留，UI 不会接管或终止它。3301 或 5173 已被占用时启动失败，不会向旧服务静默转发。可通过 `TITAN_CONTROL_PLANE_PORT` 和 `TITAN_UI_PORT` 更换端口。Ctrl-C 停止 UI 时会停止由它创建的控制面与 Daemon，保留数据库、设备状态和产物。

## 在界面添加真实 Key

1. 进入左侧“环境与 Key”。
2. 在 Qwen 卡片密码框输入百炼官方 Key，点击“保存到本机密钥链”。当前默认北京地域。
3. 在 Codex 卡片输入 OpenAI 官方 API Key，点击“保存到本机密钥链”。
4. macOS 若要求解锁“登录”钥匙串或授权访问，请在系统对话框完成操作。
5. 输入框提交后立即清空。刷新后“已配置”仅表示本机存储存在，尚未验证模型权限、网络或余额。
6. 点击“启动本机 Daemon”，等待就绪，再进入任务面板创建执行配置。

| 提供方 | macOS Keychain 项目 | Session 凭证引用 |
| --- | --- | --- |
| Codex | `titan-openai` | `keychain://titan-openai` |
| Qwen | `titan-qwen` | `keychain://titan-qwen` |

Key 从回环地址传给专用网关，再通过子进程标准输入写入 Keychain，不出现在进程参数中，不写浏览器 localStorage、业务数据库或普通日志。页面不会返回 Key。替换时重新输入并点击“更新本机 Key”；撤销可在 macOS 钥匙串访问中手动删除对应项目，或在供应商后台撤销。

界面保存仅支持 macOS；其他系统继续采用 `env://` 和 Headless Daemon 显式环境变量注入。此入口不会将 Key 写入 `.env`。

## 人工验收流程

1. “任务工作台”创建项目、任务及逐条验收标准。
2. 按问题确认、研究分析、方案设计、结构拆解、执行计划顺序编辑 Markdown。
3. 每阶段先“保存新版本”，审阅后“批准此版本”，再“推进下一阶段”。保存不会自动批准，上游变化会使下游审批链失效。
4. 到“开发执行”后进入“运行与事件”，选择 Daemon、提供方、授权工作区及账户可用模型。
5. 创建 Session 后，再显式点击“开始真实运行”。此动作会调用模型并可能产生 API 费用。
6. 查看事件与状态，操作暂停、恢复或取消。恢复创建新的 Run attempt，不覆盖旧记录。
7. “工件与证据”查看固定版本正文、SHA-256、来源和 URI，并核对真实文件。

Qwen 默认 `qwen-plus`；Codex 留空使用原生 App Server 默认模型。必须选择账户有权限的模型。新加坡等地域的 Qwen Key 不能与默认北京端点混用，需先配置对应 Provider endpoint。

缺少 Key、Daemon 未就绪、计划未批准或任务未进入开发执行时，界面会阻止提交。连接失败显示错误，不生成演示数据。

## 安全与开发边界

- UI 与专用控制面只绑定回环地址，不适合公网、共享服务器或多人使用。
- Key 保存和 Daemon 管理要求同源、JSON Content-Type 和临时 CSRF token；拒绝跨站 Origin 与非本机 Host。
- Console 和正文接口通过独立 `TITAN_CONSOLE_TOKEN` 认证；启动器随机生成，仅留在服务端，不同于模型 Key。
- 正文只读取已登记、归属正确且 SHA-256 一致的受控文件，上限 2 MiB；拒绝越界、跨工件符号链接和内容篡改。
- 不提供通用操作系统沙箱。

前端单独开发：先执行 `TITAN_UI_DEV=1 pnpm ui`，另一个终端执行 `pnpm --filter @titan/web-console dev`，访问 `http://127.0.0.1:5174`。

## 验证命令

```bash
pnpm build
pnpm typecheck
pnpm lint
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm test --force
node packages/contracts/openapi/generate.mjs --check
```

自动化测试不使用真实 Key；真实 Keychain 存储和供应商推理留给操作者在本机验收。

本轮浏览器与回归证据见 [UI 验证记录](ui-test-report.md)。
