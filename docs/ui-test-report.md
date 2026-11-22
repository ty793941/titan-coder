# 本机验收 UI 验证记录

日期：2026-11-22。用户已授权增加 UI，并要求提供真实 Key 配置方法。此记录不代表真实 Keychain 写入或供应商推理验收通过。

## 交付内容

- Vue 3 中文工作台：任务、运行与事件、工件与证据、环境与 Key 四个视图。
- 实际 PostgreSQL 列表查询与固定工件正文读取，独立 Console token 认证。
- 回环地址网关、macOS Keychain 保存入口、CSRF/Origin/Host 校验、本机 Daemon 启动与停止。
- `pnpm ui` 启动入口与 `docs/ui-acceptance.md` 操作说明。

## 浏览器验收

使用本机 Chrome 的无头独立实例与 Playwright，不复用用户登录或浏览器配置。在实际 UI 和 PostgreSQL 上操作：

1. 创建独立的 UI 验收项目及任务。
2. 五个准备阶段分别输入正文、保存新版本、批准并推进，最终到开发执行。
3. 验证缺少真实 Key 时 Session 创建不可提交。
4. 从“环境与 Key”启动真实本机 Daemon，确认设备就绪。
5. 工件页面显示五个批准版本，正文、SHA-256、URI 与来源来自实际 API。
6. 密码输入框、移动导航可操作；1440px 桌面和 390px 窄屏无横向溢出，0 个页面 JavaScript 异常。

没有输入真实 Key，没有调用付费模型。Key 保存测试使用注入的离线存储与子进程替身。

## 自动化验证

Node 22.23.5、PostgreSQL 17.12。构建、类型检查、TypeScript 静态检查、OpenAPI 生成一致性检查通过。`lint` 当前是 TypeScript 检查，不是独立 ESLint。

按包串行验证，各包最多两个 Vitest Worker：

| 模块 | 通过数量 |
| --- | ---: |
| contracts | 26 |
| web-console | 31 |
| daemon-protocol | 1 |
| cli | 30 |
| domain | 4 |
| agent-core | 57 |
| daemon | 35 |
| agent-runtime | 31 |
| control-plane | 93 |
| 合计 | 308 |

最初的高并发尝试出现过 Codex 离线短超时及 Git 文件扫描超时；串行检查未放宽断言。随后发现指定的旧全局 Codex 链接失效，实际原生探测改用本机有效的 ChatGPT 随附 Codex，57 项 Core 测试完整通过。测试使用合成 Key 进行协议探测，不请求模型推理。

## 评审与安全回归

只读 Reviewer 对修复复核结论为 `approve`，范围包括：脱敏 Session 仍可显式创建 Run、中文分块请求正确解码、控制面认证就绪门禁、开发代理 Host、Daemon 地址命名空间，以及工件固定真实路径与符号链接竞态。

网关回归覆盖同源、缺少 Origin、跨站表单、失效 CSRF、DNS 重绑定 Host、Key 不回显、不进入 argv、控制字符注入、只读认证代理与服务端 token 不返回浏览器。

## 保留限制

- 真实 Keychain 保存需操作者在 macOS 中确认；可能出现系统解锁或访问授权对话框。
- “已配置”仅代表本机存在凭证，账号权限、地域与模型可用性仍需真实 Run 验证。
- 只监听本机，未实现多人认证或公网部署。
- Qwen 默认北京 endpoint，其他地域需匹配 Provider 配置。
- 查询每类集合最多 100 条，当前是本机验收工作台，不是完整生产控制台。
