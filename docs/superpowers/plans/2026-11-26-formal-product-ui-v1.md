# Titan 正式产品 UI V1 实施计划

> 执行方式：按任务逐项实现、测试和评审；本轮使用独立工作树串行实现及只读评审。

**目标：** 将当前开发验收控制台与正式产品入口分离，交付面向项目负责人的 Decision Desk：默认进入“我的决策”，并能进入项目空间、审阅真实工件和完成真实审批。

**架构：** 保留现有验收控制台作为 `#/acceptance` 开发入口，把根路径切换为正式产品壳层。正式 UI 只在前端组合 Project、Task、Artifact、Session、Run 和事件事实，使用适配器生成决策队列；决策详情通过既有审批和阶段推进 API 完成真实操作，不新增重复领域事实。执行详情复用现有 API 和组件能力，但从正式产品的项目页面进入。

**技术栈：** Vue 3、TypeScript、Vite、Vitest、Vue Test Utils、Lucide Vue、现有 Control Plane API。

---

## 实施记录（2026-11-26）

- [x] 分离正式产品入口和开发验收入口，根路径进入“我的决策”。
- [x] 实现决策适配、跨项目数据加载、错误脱敏和局部同步警告。
- [x] 实现正式壳层、项目目录、项目空间、工作目标创建和阶段资料入口。
- [x] 实现正文读取与校验、真实批准、版本化阶段推进和批准后导航。
- [x] 实现独立执行、环境设置、交付物按需正文读取和项目活动页面。
- [x] 53 项前端测试通过；全仓无缓存构建、类型和静态检查共 33 项任务通过；OpenAPI 一致性通过。
- [x] 真实 Chrome、Control Plane、PostgreSQL 的项目创建到交付物阅读全流程通过，覆盖 375、768、1024、1440 四种屏宽，无页面脚本错误；最终只读评审为 `approve`。

实际测试统一位于 `apps/web-console/test/product-*.test.ts`，遵循项目现有 Vitest include 规则；没有按早期草案把测试放在 `src/product/`。实际新增 `DocumentReader.vue` 和 `GoalDialog.vue`，前者负责正文校验，后者负责项目/目标创建。正式执行详情位于 `#/executions/:runId`，新执行入口位于 `#/tasks/:taskId/execution`，不再把正式产品操作导航到验收控制台。项目经理当前为状态摘要和新目标入口，实时模型对话仍待后续后端接入。

下文保留实施时的分步设计，最终验收事实以 `docs/formal-ui-acceptance.md` 为准。

## 文件结构与职责

- `apps/web-console/src/App.vue`：正式产品路由入口，根据 hash 显示正式产品或验收入口。
- `apps/web-console/src/components/AcceptanceConsole.vue`：保存当前验收控制台布局和开发验收导航。
- `apps/web-console/src/product/types.ts`：正式 UI 的决策、项目脉搏和路由类型。
- `apps/web-console/src/product/decisions.ts`：从真实控制面状态和工件生成决策项，并定义排序、状态和文案。
- `apps/web-console/src/product/useProductData.ts`：加载项目负责人首页所需的项目、任务和每个任务的工件，处理刷新、取消和错误。
- `apps/web-console/src/product/routes.ts`：无额外路由依赖的 hash 路由，支持收件箱、项目空间、交付物和活动页面的深链接。
- `apps/web-console/src/components/product/ProductShell.vue`：正式产品的全局导航、工作区头部、移动端抽屉和通知出口。
- `apps/web-console/src/components/product/DecisionInbox.vue`：默认首页，显示今日判断、决策队列和项目脉搏。
- `apps/web-console/src/components/product/DecisionDetail.vue`：决策详情，显示背景、建议、影响和真实批准/推进操作。
- `apps/web-console/src/components/product/ProjectSpace.vue`：项目空间混合视图，显示目标、健康度、里程碑、风险、项目叙事、Agent 摘要和交付物。
- `apps/web-console/src/components/product/DeliveryView.vue`：跨项目交付物列表和正文预览入口。
- `apps/web-console/src/components/product/ActivityView.vue`：关键项目活动摘要，隐藏原始工具输出。
- `apps/web-console/src/components/product/ProductEmptyState.vue`：正式产品语境下的无项目、无决策和未接入状态。
- `apps/web-console/src/product/decisions.test.ts`：决策适配器单元测试。
- `apps/web-console/src/product/routes.test.ts`：正式产品 hash 路由测试。
- `apps/web-console/test/product-components.test.ts`：正式产品组件的 jsdom 交互测试。
- `apps/web-console/src/styles.css`：保留验收样式并新增隔离的 `product-*` 设计系统样式；正式产品禁止复用验收页面布局类。
- `apps/web-console/test/product-browser-smoke.py`：Playwright 浏览器验收脚本；无浏览器依赖时由门禁明确记录环境限制。
- `docs/implementation-roadmap.md`：记录 Phase 2C 正式产品 UI V1 的完成边界和后续多人协作阶段。

## Task 1: 分离正式产品入口和验收控制台

**Files:**
- Create: `apps/web-console/src/components/AcceptanceConsole.vue`
- Modify: `apps/web-console/src/App.vue`
- Test: `apps/web-console/src/product/routes.test.ts`

- [ ] **Step 1: 写 hash 路由失败测试**

在 `routes.test.ts` 写入以下行为：根路径解析为 `inbox`；`#/projects/project-1` 解析为项目空间；`#/decisions/decision-1` 解析为决策详情；`#/acceptance` 解析为验收入口；未知路径回退到 `inbox`；项目 ID 和决策 ID 只接受单一路径片段，不能把 hash 内容直接当作 HTML 或脚本执行。

```ts
import { describe, expect, it } from "vitest";
import { parseProductRoute, productRoute } from "./routes";

describe("正式产品路由", () => {
  it("默认进入我的决策", () => {
    expect(parseProductRoute("")).toEqual({ name: "inbox" });
  });

  it("支持项目和决策深链接", () => {
    expect(parseProductRoute("#/projects/project-1")).toEqual({ name: "project", projectId: "project-1" });
    expect(parseProductRoute("#/decisions/decision-1")).toEqual({ name: "decision", decisionId: "decision-1" });
    expect(productRoute({ name: "project", projectId: "project-1" })).toBe("#/projects/project-1");
  });

  it("把验收控制台放在明确的开发入口", () => {
    expect(parseProductRoute("#/acceptance")).toEqual({ name: "acceptance" });
    expect(parseProductRoute("#/unexpected")).toEqual({ name: "inbox" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/routes.test.ts --maxWorkers=1`

预期：因为 `routes.ts` 和路由类型尚不存在而失败。

- [ ] **Step 3: 实现纯函数路由**

创建 `routes.ts`，使用固定正则解析有限路径，不把 hash 内容拼接进 HTML；路由类型如下：

```ts
export type ProductRoute =
  | { name: "inbox" }
  | { name: "project"; projectId: string }
  | { name: "decision"; decisionId: string }
  | { name: "deliveries" }
  | { name: "activity" }
  | { name: "acceptance" };

export function parseProductRoute(hash: string): ProductRoute {
  const value = hash.replace(/^#/, "");
  if (value === "/acceptance") return { name: "acceptance" };
  if (value === "/deliveries") return { name: "deliveries" };
  if (value === "/activity") return { name: "activity" };
  const project = /^\/projects\/([^/?#]+)$/.exec(value);
  if (project) return { name: "project", projectId: decodeURIComponent(project[1]!) };
  const decision = /^\/decisions\/([^/?#]+)$/.exec(value);
  if (decision) return { name: "decision", decisionId: decodeURIComponent(decision[1]!) };
  return { name: "inbox" };
}

export function productRoute(route: ProductRoute): string {
  if (route.name === "inbox") return "#/";
  if (route.name === "acceptance") return "#/acceptance";
  if (route.name === "project") return `#/projects/${encodeURIComponent(route.projectId)}`;
  if (route.name === "decision") return `#/decisions/${encodeURIComponent(route.decisionId)}`;
  return `#/${route.name}`;
}
```

- [ ] **Step 4: 迁移当前验收 App**

将当前 `App.vue` 的完整模板和逻辑移动到 `AcceptanceConsole.vue`，保持其 `useConsole`、验收导航、凭证入口和执行详情逻辑不变。新的 `App.vue` 只负责读取 `window.location.hash`、渲染正式产品或 `<AcceptanceConsole />`，并在 hashchange 时更新路由。

- [ ] **Step 5: 运行路由测试和现有控制台测试**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/routes.test.ts test --maxWorkers=1`

预期：路由测试和原有 31 项测试全部通过。

- [ ] **Step 6: 提交入口分离**

```bash
git add apps/web-console/src/App.vue apps/web-console/src/components/AcceptanceConsole.vue apps/web-console/src/product/routes.ts apps/web-console/src/product/routes.test.ts
git commit -m "重构：分离正式产品与验收控制台入口"
```

## Task 2: 建立真实状态到决策队列的适配层

**Files:**
- Create: `apps/web-console/src/product/types.ts`
- Create: `apps/web-console/src/product/decisions.ts`
- Create: `apps/web-console/src/product/decisions.test.ts`
- Modify: `apps/web-console/src/types.ts` only when a shared type is missing

- [ ] **Step 1: 写决策适配器失败测试**

覆盖以下真实规则：待批准最新工件生成 `review_artifact`；已批准计划且任务仍在计划阶段生成 `advance_stage`；运行处于 `waiting_input`、`reconnecting` 或 `failed` 时生成 `execution_attention`；没有匹配事实时返回空数组；排序按 `critical/high/medium/low` 再按更新时间；决策卡不包含 Secret、Prompt、Checkpoint 内容或原始工具输出。

```ts
const decisions = buildDecisions({
  projects: [project],
  tasks: [task],
  artifactsByTask: new Map([[task.id, [pendingQuestionsArtifact]]]),
  sessions: [],
  runs: [],
});
expect(decisions[0]).toMatchObject({ type: "review_artifact", taskId: task.id, artifactId: "questions-2" });
expect(JSON.stringify(decisions)).not.toContain("secret");
expect(JSON.stringify(decisions)).not.toContain("prompt");
```

- [ ] **Step 2: 运行失败测试**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/decisions.test.ts --maxWorkers=1`

预期：因为正式 UI 决策类型和适配函数尚不存在而失败。

- [ ] **Step 3: 定义最小正式 UI 类型**

在 `types.ts` 增加：

```ts
export type DecisionType = "review_artifact" | "advance_stage" | "execution_attention";
export type DecisionPriority = "critical" | "high" | "medium" | "low";
export interface ProductDecision {
  id: string;
  type: DecisionType;
  priority: DecisionPriority;
  projectId: string;
  taskId: string;
  title: string;
  summary: string;
  whyNow: string;
  recommendation: string;
  impact: string;
  actionLabel: string;
  artifactId?: string;
  runId?: string;
  createdAt: string;
}
```

- [ ] **Step 4: 实现适配器**

`buildDecisions(input)` 只读取已定义的 Project、Task、Artifact、Session、Run 字段；使用 `latestArtifact`、`approvedChain` 和 `statusLabel` 复用现有业务展示函数。决策 ID 必须由类型和稳定对象 ID 组成，例如 `review_artifact:${artifactId}`，确保刷新不产生重复决策。对 `waiting_input` 显示“需要项目负责人提供信息”，对 `reconnecting` 显示“执行正在恢复”，对 `failed` 显示安全错误码，不显示 HTTP 正文。

- [ ] **Step 5: 运行决策测试**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/decisions.test.ts --maxWorkers=1`

预期：所有决策排序、映射、脱敏和空状态测试通过。

- [ ] **Step 6: 提交决策适配层**

```bash
git add apps/web-console/src/product/types.ts apps/web-console/src/product/decisions.ts apps/web-console/src/product/decisions.test.ts
git commit -m "新增：构建项目负责人决策队列适配层"
```

## Task 3: 加载正式首页所需的真实项目数据

**Files:**
- Create: `apps/web-console/src/product/useProductData.ts`
- Create: `apps/web-console/src/product/product-data.test.ts`
- Modify: `apps/web-console/src/api.ts` only if a typed read endpoint helper is missing

- [ ] **Step 1: 写数据加载失败测试**

测试 `loadProductData` 能并行加载 console state 和当前项目任务的工件；任一任务的工件请求失败时保留其他任务数据并记录可展示错误；AbortSignal 取消后不更新状态；空项目返回空决策而不是演示数据。

- [ ] **Step 2: 运行失败测试**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/product-data.test.ts --maxWorkers=1`

预期：因为 `useProductData` 尚不存在而失败。

- [ ] **Step 3: 实现 composable**

`useProductData` 复用 `api.state`、`api.localStatus` 和 `api.artifacts`，使用 `Promise.allSettled` 加载任务工件；每次项目切换先 abort 上一次请求；返回 `state`、`local`、`artifactsByTask`、`decisions`、`loading`、`error`、`lastSync` 和 `refresh`。所有网络错误转为 `errorMessage`，不把响应正文透传到产品 UI。

- [ ] **Step 4: 运行数据测试**

运行：`pnpm --filter @titan/web-console exec vitest run src/product/product-data.test.ts --maxWorkers=1`

预期：加载、部分失败、取消和空项目测试通过。

- [ ] **Step 5: 提交数据层**

```bash
git add apps/web-console/src/product/useProductData.ts apps/web-console/src/product/product-data.test.ts
git commit -m "新增：加载正式产品项目状态与交付证据"
```

## Task 4: 实现正式产品壳层和“我的决策”首页

**Files:**
- Create: `apps/web-console/src/components/product/ProductShell.vue`
- Create: `apps/web-console/src/components/product/DecisionInbox.vue`
- Create: `apps/web-console/src/components/product/ProductEmptyState.vue`
- Create: `apps/web-console/test/product-components.test.ts`
- Modify: `apps/web-console/src/App.vue`
- Modify: `apps/web-console/src/styles.css`

- [ ] **Step 1: 写组件失败测试**

测试正式壳层显示“我的决策、项目、交付物、活动”；根首页显示“今日判断、决策队列、项目脉搏”；没有决策时显示正式产品空状态；决策卡的唯一主按钮为“处理此事项”；点击项目次级入口 emits 项目路由；页面不渲染 `LOCAL`、`PHASE 01`、`EXECUTION ENGINE`。

- [ ] **Step 2: 运行失败测试**

运行：`pnpm --filter @titan/web-console exec vitest run test/product-components.test.ts --maxWorkers=1`

预期：因为正式产品组件尚不存在而失败。

- [ ] **Step 3: 实现 ProductShell**

ProductShell 接收 `route`、`decisions`、`projects`、`loading` 和错误状态，使用 `<nav aria-label="产品导航">`，主导航链接调用 `productRoute`，移动端使用按钮打开抽屉。顶栏提供工作区名称、搜索占位、通知和刷新；刷新按钮使用 `aria-label`，异步时禁用并显示状态。

- [ ] **Step 4: 实现 DecisionInbox**

首页顶部展示“今天要决定的事”和待处理数量；决策卡显示项目名、事项标题、背景、建议、影响、优先级文本和“处理此事项”主按钮。没有真实决策时显示“当前没有需要你决定的事项”，并展示真实项目脉搏；不创建 fixture 演示卡。

- [ ] **Step 5: 实现正式视觉系统**

在 `styles.css` 增加隔离的 `product-*` 变量和组件样式：纸张背景、深墨色文字、蓝绿色主行动色、琥珀风险色；标题使用项目已有可用字体栈中的编辑感字体，正文保持中文可读性；使用 4/8px 间距、44px 最小操作区域、清晰焦点和 150–300ms 状态过渡。新增 `prefers-reduced-motion` 覆盖，不修改验收 UI 的现有视觉规则。

- [ ] **Step 6: 运行组件测试和类型检查**

运行：`pnpm --filter @titan/web-console exec vitest run test/product-components.test.ts --maxWorkers=1 && pnpm --filter @titan/web-console typecheck`

预期：正式组件测试通过，类型检查退出码为 0。

- [ ] **Step 7: 提交正式首页**

```bash
git add apps/web-console/src/App.vue apps/web-console/src/components/product apps/web-console/src/styles.css apps/web-console/test/product-components.test.ts
git commit -m "新增：交付项目负责人的正式决策首页"
```

## Task 5: 实现项目空间和决策详情的真实操作

**Files:**
- Create: `apps/web-console/src/components/product/ProjectSpace.vue`
- Create: `apps/web-console/src/components/product/DecisionDetail.vue`
- Create: `apps/web-console/src/components/product/DeliveryView.vue`
- Create: `apps/web-console/src/components/product/ActivityView.vue`
- Modify: `apps/web-console/src/components/product/ProductShell.vue`
- Modify: `apps/web-console/src/product/decisions.ts`
- Modify: `apps/web-console/src/api.ts` only when an existing typed method is insufficient
- Modify: `apps/web-console/test/product-components.test.ts`

- [ ] **Step 1: 写真实决策交互失败测试**

测试打开 `review_artifact` 决策时显示来源、版本和校验信息；点击“批准方案”调用 `api.approveArtifact(artifactId)`，成功后刷新决策并显示成功通知；API 返回 409 时显示“内容已更新，请重新审阅”，不显示原始响应正文；`advance_stage` 调用 `api.advanceStage(taskId, nextStage, expectedVersion)`；没有可执行真实动作的事项显示次级查看入口，不伪造成功。

- [ ] **Step 2: 运行失败测试**

运行：`pnpm --filter @titan/web-console exec vitest run test/product-components.test.ts --maxWorkers=1`

预期：因详情组件和动作处理尚不存在而失败。

- [ ] **Step 3: 实现 DecisionDetail**

详情页按“发生了什么、为什么现在、项目经理建议、影响、下一步”五段展示；底部只有一个 `button.product-primary-action` 主操作；操作期间禁用按钮并显示“处理中”，成功后触发 `refresh` 和 `notify`，失败根据 `ApiError.status` 映射安全提示。

- [ ] **Step 4: 实现 ProjectSpace**

项目空间顶部显示项目目标、健康状态、当前阶段、风险和待决策数量；中部使用叙事时间线展示真实任务的阶段和最新工件；底部展示项目经理摘要、活动 Run 和最近交付物。点击待决策进入详情，点击交付物进入交付页，点击运行进入验收控制台的执行详情 hash。

- [ ] **Step 5: 实现交付物和活动次级页面**

交付物页面只显示真实 Artifact 的项目、阶段、版本、评审状态和摘要；活动页面显示安全的项目级活动类型、发生时间和关联任务，不展示完整 Tool payload、Prompt、Checkpoint 或凭证。

- [ ] **Step 6: 运行交互测试**

运行：`pnpm --filter @titan/web-console exec vitest run test/product-components.test.ts --maxWorkers=1 && pnpm --filter @titan/web-console typecheck`

预期：批准、阶段推进、409 冲突、加载中和安全错误显示测试全部通过。

- [ ] **Step 7: 提交项目空间与详情**

```bash
git add apps/web-console/src/components/product apps/web-console/src/product/decisions.ts apps/web-console/src/api.ts apps/web-console/test/product-components.test.ts
git commit -m "新增：完成项目空间与决策详情闭环"
```

## Task 6: 清理临时验收扩展并补齐响应式体验

**Files:**
- Delete: `apps/web-console/src/components/ProjectCanvas.vue`
- Modify: `apps/web-console/src/App.vue`
- Modify: `apps/web-console/src/styles.css`
- Modify: `docs/implementation-roadmap.md`

- [ ] **Step 1: 移除临时 ProjectCanvas**

正式产品改用 `ProductShell` 和产品组件；删除此前仅为验收 UI 增加的 `ProjectCanvas.vue`、`project-canvas-view` 和 `canvas-*` 样式，避免两套产品概念同时存在。验收入口继续使用原始控制台组件。

- [ ] **Step 2: 实现响应式和无障碍验收规则**

在 1024px 以下将侧栏改为抽屉；在 768px 以下把项目脉搏改为单列；在 375px 下决策卡和主操作纵向排列；保持正文最小 16px、按钮最小 44px、无横向页面滚动；为菜单、抽屉、决策卡和返回动作提供键盘焦点与 `aria-expanded`。

- [ ] **Step 3: 运行前端门禁**

运行：`pnpm --filter @titan/web-console typecheck && pnpm --filter @titan/web-console test -- --maxWorkers=1 && pnpm --filter @titan/web-console build && git diff --check`

预期：类型检查、全部控制台测试、生产构建和差异检查通过。

- [ ] **Step 4: 提交响应式清理**

```bash
git add apps/web-console/src/App.vue apps/web-console/src/styles.css apps/web-console/src/components/ProjectCanvas.vue docs/implementation-roadmap.md
git commit -m "完善：收敛正式产品界面与响应式入口"
```

## Task 7: 浏览器验收和安全边界检查

**Files:**
- Create: `apps/web-console/test/product-browser-smoke.py`
- Create: `docs/formal-ui-acceptance.md`
- Modify: `docs/implementation-roadmap.md`

- [ ] **Step 1: 写浏览器验收脚本**

脚本使用 Playwright 打开根路径，等待 `networkidle`，确认默认标题是“我的决策”、导航存在、页面不显示验收标签；点击项目进入项目空间，点击决策进入详情，验证返回路径；在 375px 和 1440px 截图并检查页面没有横向滚动；捕获 console error。

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in (375, 1440):
        page = browser.new_page(viewport={"width": width, "height": 1000})
        page.goto("http://127.0.0.1:5174/#/", wait_until="networkidle")
        assert page.get_by_role("heading", name="我的决策").count() == 1
        assert page.locator("text=LOCAL").count() == 0
        assert page.locator("body").evaluate("node => node.scrollWidth <= window.innerWidth")
        page.screenshot(path=f"/tmp/titan-formal-ui-{width}.png", full_page=True)
        page.close()
    browser.close()
```

- [ ] **Step 2: 运行浏览器验收**

运行：`python3 /Users/zhanghai/.claude/skills/webapp-testing/scripts/with_server.py --server "pnpm --filter @titan/web-console dev" --port 5174 -- python3 apps/web-console/test/product-browser-smoke.py`

预期：在已安装 Python Playwright 的环境中 375px 和 1440px 均通过；如果环境缺少模块，记录为环境限制，不伪称浏览器验收通过。

- [ ] **Step 3: 写中文验收记录**

`docs/formal-ui-acceptance.md` 记录正式 UI 默认入口、真实 API 操作、响应式宽度、键盘操作、安全检查、执行命令和实际结果。明确验收 UI 的 `#/acceptance` 入口仅用于开发检查。

- [ ] **Step 4: 执行全仓相关门禁**

运行：

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @titan/web-console test -- --maxWorkers=1
node packages/contracts/openapi/generate.mjs --check
git diff --check
```

预期：全仓构建、类型检查、静态检查、控制台测试、OpenAPI 一致性和差异检查均通过。

- [ ] **Step 5: 提交验收记录**

```bash
git add apps/web-console/test/product-browser-smoke.py docs/formal-ui-acceptance.md docs/implementation-roadmap.md
git commit -m "测试：完成正式产品 UI 浏览器验收"
```

- [ ] **Step 6: 最终检查并通过代理推送**

确认 `docs/study.html`、`study.html`、`.superpowers/` 和任何用户未跟踪文件未被加入暂存区，然后执行：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=socks5://127.0.0.1:7890 \
git push origin chore/initial-project
```

推送后核对 `HEAD` 与 `refs/remotes/origin/chore/initial-project` 相同，并在最终交付中列出实际提交、验证命令和浏览器验收限制。
