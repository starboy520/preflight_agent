# Agent Run Preflight Workbench

## 1. 需求理解

### 1.1 这个功能解决什么问题

AgentOS 在真正执行 AgentRun 前，需要先判断执行计划是否具备安全、合法、可调度的前置条件。Agent Run Preflight Workbench 提供一个面向执行前检查的调试台，用于接收一份 AgentRun plan snapshot，并在不真正执行任务的情况下输出预检结果。

它重点解决以下问题：

- 提前发现结构性错误，例如任务引用不存在的 Skill、Tool 或依赖任务。
- 提前发现 DAG 依赖环，避免调度阶段出现死锁或无限等待。
- 在执行前估算 token 消耗，判断预算是否足够。
- 判断是否需要人工审批，例如 T3 Skill 或 ask 模式 Tool。
- 判断任务是否需要 Sandbox，以及在生产环境中是否需要自动升级 Sandbox 等级。
- 当并发任务超过租户上限时，给出稳定、可解释的 normalized plan。

### 1.2 使用者是谁

主要使用者有两类：

- 平台操作员：关注当前计划能否执行、为什么被阻断、是否需要审批、Sandbox 路由是否合理。
- 研发调试人员：关注规则命中原因、DAG 是否正确、预算估算是否符合预期、normalized plan 是否稳定可复现。

### 1.3 Preflight 的输入是什么

Preflight 输入是一份 AgentRun 执行计划快照，由前端以 JSON 形式提交到后端。它包含：

- `thread_id`：本次 AgentRun 所属线程。
- `environment`：执行环境，支持 `dev`、`staging`、`prod`。
- `remaining_token_budget`：当前剩余 token 预算。
- `max_parallel_tasks`：允许的最大并发任务数。
- `skills`：计划中可引用的 Skill 列表，包括状态、动作等级和 Sandbox 等级。
- `tools`：计划中可引用的 Tool 列表，包括状态和暴露模式。
- `tasks`：待执行任务列表，包括任务 ID、标题、引用的 Skill/Tool、依赖、预计 token、并发分组。

本次实现不从数据库、Skill Registry 或 Tool Registry 查询数据，所有预检依据均来自请求体。请求中的 `skills` 和 `tools` 被视为本次 AgentRun 的 registry snapshot；后端用它们判断 `tasks[].skill_id` 和 `tasks[].tool_id` 是否存在，并继续校验 status、action tier、sandbox level 和 exposure mode。

### 1.4 Preflight 的输出是什么

Preflight 输出是一份结构化结果，包含：

- `decision`：最终决策，只能是 `blocked`、`requires_approval`、`ready`。
- `can_execute`：是否允许直接执行。
- `normalized_plan`：经过并发改写后的计划。
- `budget`：token 估算和预算状态。
- `governance`：动作等级、审批状态和审批原因。
- `sandbox`：是否需要 Sandbox、最高 Sandbox 等级和路由建议。
- `errors`：阻断问题列表。
- `warnings`：非阻断风险或改写说明。
- `audit_notes`：本次预检完成的审计说明。

### 1.5 它在 AgentRun 执行链路中的业务价值

Preflight 位于 AgentRun 调度执行之前，是执行链路中的风险前置层。它的价值在于：

- 将不可执行计划提前阻断，减少运行中失败。
- 将审批原因结构化，方便治理系统或人工操作员接入。
- 将 Sandbox 路由建议前置，避免执行阶段临时升级带来的不确定性。
- 将并发超限改写为 normalized plan，让后续调度器拿到更稳定的输入。
- 将所有预检结果统一表达，方便审计、排查和回放。

### 1.6 本次上机题明确不做哪些内容

为了控制在 3-4 小时可交付范围内，本次不实现以下能力：

- 不实现用户登录、租户权限、RBAC 或操作审计查询。
- 不接入真实数据库，不保存历史 Preflight 记录。
- 不接入真实 Skill Registry、Tool Registry 或 Governance Center。
- 不维护后端内置 Skill/Tool 白名单；本次以请求携带的 `skills` 和 `tools` 作为可引用能力清单。
- 不实现真实审批流，只返回审批判定和审批原因。
- 不执行 AgentRun，不调度真实任务。
- 不启动真实 Sandbox，只返回 Sandbox route 建议。
- 不实现复杂租户策略配置中心，规则以内置策略实现。
- 不实现复杂 UI 工作流，例如 diff 视图、历史版本比较、批量导入。

## 2. 业务规则拆解

### 2.1 Skill 校验规则

命中条件和结果：

- 任务引用不存在的 Skill：生成 error，最终 `decision=blocked`。
- Skill `status != active`：生成 error，最终 `decision=blocked`。
- 任一被任务引用的 Skill `action_tier=T3`：不阻断，但生成 approval reason，最终可能为 `requires_approval`。

表达方式：

- missing skill 使用 `code=missing_skill`。
- inactive skill 使用 `code=inactive_skill`。
- T3 审批原因写入 `governance.approval_reasons`。

### 2.2 Tool 校验规则

命中条件和结果：

- 任务引用不存在的 Tool：生成 error，最终 `decision=blocked`。
- Tool `status != active`：生成 error，最终 `decision=blocked`。
- Tool `exposure_mode=deny`：生成 error，最终 `decision=blocked`。
- Tool `exposure_mode=ask`：不阻断，但生成 approval reason。
- Tool `exposure_mode=allow`：可继续执行。

表达方式：

- missing tool 使用 `code=missing_tool`。
- inactive tool 使用 `code=inactive_tool`。
- deny tool 使用 `code=tool_denied`。
- ask tool 审批原因写入 `governance.approval_reasons`。

### 2.3 DAG 依赖校验规则

命中条件和结果：

- 任务依赖不存在的 task：生成 error，最终 `decision=blocked`。
- 任务依赖形成环：生成 error，最终 `decision=blocked`，并在 `details.cycle_path` 返回环路路径。
- 依赖完整且无环：通过，写入 `audit_notes=["dag_validated"]`。

DAG 校验只校验任务之间的依赖结构，不校验 Skill 和 Tool 的状态。Skill/Tool 问题由独立规则处理，便于前端展示多个问题。

### 2.4 Token 预算规则

命中条件和结果：

- 将所有任务的 `estimated_tokens` 求和，得到 `budget.estimated_tokens`。
- 如果总和超过 `remaining_token_budget`：生成 error，最终 `decision=blocked`，`budget.budget_status=exceeded`。
- 如果未超过预算：返回 `remaining_after_preflight`，`budget.budget_status=ok`。

Token 预算不考虑模型上下文窗口、工具额外开销和重试开销。本次仅做计划级静态估算。

### 2.5 并发改写规则

命中条件和结果：

- 同一 `parallel_group` 内任务数超过 `max_parallel_tasks`：不阻断。
- 后端在 `normalized_plan` 中把超额任务改写为串行依赖。
- 返回 warning，说明被改写的 parallel group 和改写策略。
- 并发改写完成后，需要对 `normalized_plan` 再执行一次 DAG 校验，避免新增依赖引入环路。

稳定改写策略：

- 保持输入任务顺序。
- 按 `parallel_group` 分组。
- 对每个分组，前 `max_parallel_tasks` 个任务保持原依赖。
- 从第 `max_parallel_tasks + 1` 个任务开始，给当前任务追加同组前一个任务作为依赖。
- 如果依赖已存在，不重复追加。

示例：

```txt
max_parallel_tasks = 2
parallel_group g1 = [t1, t2, t3, t4]
```

改写后：

```txt
t1 depends_on []
t2 depends_on []
t3 depends_on [t2]
t4 depends_on [t3]
```

每个被改写的任务会在 `normalization_notes` 中记录原因，例如 `parallel_group g1 exceeds max_parallel_tasks=2; added dependency on t2`。

如果 normalized plan 校验发现环路，返回 `code=normalized_dag_cycle` 的 error，最终 `decision=blocked`。这类情况通常说明原始依赖和并发改写策略组合后产生了新的结构冲突，需要用户调整任务分组或依赖关系。

### 2.6 Sandbox 升级规则

命中条件和结果：

- Skill 的 `sandbox_level` 可为 `none / L0 / L1 / L2 / L3`。
- `none` 表示不需要 Sandbox。
- 非 `none` 表示任务需要 Sandbox route。
- `environment=prod` 时，`L0` 和 `L1` 自动升级为 `L2`。
- Sandbox 升级不阻断，但必须返回 warning 和 route reason。

Sandbox 汇总：

- `sandbox.required` 表示是否存在任何需要 Sandbox 的任务。
- `sandbox.highest_level` 表示升级后的最高 Sandbox 等级。
- `sandbox.routes` 按任务列出最终 Sandbox 等级和原因。

### 2.7 审批判定规则

以下情况需要审批：

- 任一被任务引用的 Skill `action_tier=T3`。
- 任一被任务引用的 Tool `exposure_mode=ask`。

审批只影响 `decision=requires_approval`，不生成 error。若同时存在 error 和审批原因，最终仍为 `blocked`，审批原因仍保留在响应中，便于操作员一次性看到所有风险。

### 2.8 `blocked / requires_approval / ready` 的优先级

最终决策优先级固定：

1. 如果 `errors` 非空：`decision=blocked`，`can_execute=false`。
2. 如果 `errors` 为空但需要审批：`decision=requires_approval`，`can_execute=false`。
3. 如果无 error 且无需审批：`decision=ready`，`can_execute=true`。

该优先级保证阻断问题永远优先于审批问题，避免用户误以为审批后即可执行一个结构非法的计划。

## 3. 接口设计

### 3.1 后端接口路径和方法

```http
POST /api/v1/platform/runtime/agent-runs/preflight
Content-Type: application/json
```

接口语义：

- 接收 AgentRun plan snapshot。
- 执行静态预检规则。
- 返回统一结构化 Preflight 结果。
- 不产生副作用，不写数据库，不触发真实执行。

### 3.2 请求 JSON schema 示例

```json
{
  "thread_id": "thd-001",
  "environment": "prod",
  "remaining_token_budget": 9000,
  "max_parallel_tasks": 2,
  "skills": [
    {
      "skill_id": "knowledge.search",
      "status": "active",
      "action_tier": "T1",
      "sandbox_level": "none"
    },
    {
      "skill_id": "report.generate",
      "status": "active",
      "action_tier": "T2",
      "sandbox_level": "L1"
    }
  ],
  "tools": [
    {
      "tool_id": "web.search",
      "status": "active",
      "exposure_mode": "allow"
    },
    {
      "tool_id": "artifact.write",
      "status": "active",
      "exposure_mode": "ask"
    }
  ],
  "tasks": [
    {
      "task_id": "t1",
      "title": "Search source material",
      "skill_id": "knowledge.search",
      "tool_id": "web.search",
      "depends_on": [],
      "estimated_tokens": 1800,
      "parallel_group": "g1"
    },
    {
      "task_id": "t2",
      "title": "Generate report",
      "skill_id": "report.generate",
      "tool_id": "artifact.write",
      "depends_on": ["t1"],
      "estimated_tokens": 3200,
      "parallel_group": "g1"
    }
  ]
}
```

基础字段约束：

- `environment`：枚举 `dev / staging / prod`。
- `remaining_token_budget`：非负整数。
- `max_parallel_tasks`：大于等于 1 的整数。
- `estimated_tokens`：非负整数。
- `tasks`：至少包含 1 个任务。
- enum 字段均限制为题目定义的合法值。

### 3.3 响应 JSON schema 示例

```json
{
  "decision": "requires_approval",
  "can_execute": false,
  "normalized_plan": {
    "tasks": [
      {
        "task_id": "t1",
        "title": "Search source material",
        "skill_id": "knowledge.search",
        "tool_id": "web.search",
        "depends_on": [],
        "estimated_tokens": 1800,
        "parallel_group": "g1",
        "normalization_notes": []
      },
      {
        "task_id": "t2",
        "title": "Generate report",
        "skill_id": "report.generate",
        "tool_id": "artifact.write",
        "depends_on": ["t1"],
        "estimated_tokens": 3200,
        "parallel_group": "g1",
        "normalization_notes": []
      }
    ]
  },
  "budget": {
    "estimated_tokens": 5000,
    "remaining_after_preflight": 4000,
    "budget_status": "ok"
  },
  "governance": {
    "highest_action_tier": "T2",
    "approval_required": true,
    "approval_reasons": [
      "tool artifact.write uses exposure_mode=ask"
    ]
  },
  "sandbox": {
    "required": true,
    "highest_level": "L2",
    "routes": [
      {
        "task_id": "t2",
        "sandbox_level": "L2",
        "reason": "prod environment upgrades L1 sandbox to L2"
      }
    ]
  },
  "errors": [],
  "warnings": [
    {
      "code": "prod_sandbox_upgrade",
      "message": "task t2 sandbox level upgraded from L1 to L2 in prod",
      "field": "tasks[1].skill_id",
      "details": {
        "from": "L1",
        "to": "L2"
      }
    }
  ],
  "audit_notes": [
    "dag_validated",
    "budget_prechecked",
    "sandbox_route_estimated",
    "approval_required"
  ]
}
```

### 3.4 error / warning / audit note 的表达方式

`errors` 和 `warnings` 使用相同结构：

```json
{
  "code": "dag_cycle",
  "message": "dependency cycle detected: t1 -> t2 -> t1",
  "field": "tasks.depends_on",
  "details": {
    "cycle_path": ["t1", "t2", "t1"]
  }
}
```

字段说明：

- `code`：稳定机器码，便于前端展示、测试断言和未来国际化。
- `message`：给操作员看的可读说明。
- `field`：尽量指向出错字段，便于定位。
- `details`：可选结构化上下文，例如 cycle path、预算差额、改写原因。

`audit_notes` 使用稳定字符串数组，例如：

- `dag_validated`
- `budget_prechecked`
- `parallel_plan_normalized`
- `sandbox_route_estimated`
- `approval_required`
- `ready_for_execution`

### 3.5 为什么这样设计

统一响应结构可以让前端不需要为 blocked、approval 和 ready 分别维护三套解析逻辑。结构化 issue 能同时满足人读和机器读，适合后续扩展为审计、告警、国际化或运营报表。`audit_notes` 使用稳定字符串而不是长文本，是为了降低接口耦合，并让测试更稳定。

## 4. 后端设计

### 4.1 分层设计

后端采用独立 FastAPI 工程，目录结构如下：

```txt
backend/
  app/
    main.py
    api/
      preflight.py
    schemas/
      preflight.py
    services/
      preflight_service.py
    domain/
      preflight_engine.py
      policies.py
  tests/
    test_agent_run_preflight.py
```

职责划分：

- router：定义 HTTP 路由，处理请求/响应边界，不写业务规则。
- schema：定义 Pydantic 请求和响应模型，承载 enum、基础字段校验和 OpenAPI schema。
- service：应用服务入口，调用 domain engine，未来可在这里接入 registry、审计、审批。
- domain / policy：承载核心业务规则，输出 errors、warnings、approval reasons、normalized plan 等结果。

### 4.2 核心数据结构

主要请求模型：

- `PreflightRequest`
- `SkillRef`
- `ToolRef`
- `TaskPlan`

主要响应模型：

- `PreflightResponse`
- `NormalizedPlan`
- `NormalizedTask`
- `BudgetSummary`
- `GovernanceSummary`
- `SandboxSummary`
- `SandboxRoute`
- `PreflightIssue`

内部计算模型：

- `PreflightContext`：保存 request、skill index、tool index、task index。
- `PolicyResult`：承载某个 policy 返回的 errors、warnings、approval reasons、audit notes。

### 4.3 主要算法说明

#### DAG 环路检测

DAG 校验分两步：

1. 建立 `task_id -> task` 索引，检查每个 `depends_on` 是否存在。
2. 对任务依赖图做 DFS 三色标记。

颜色状态：

- `unvisited`：尚未访问。
- `visiting`：当前 DFS 路径中。
- `visited`：已完成访问。

当 DFS 访问到 `visiting` 节点时，说明存在环。从当前路径中截取第一次出现该节点的位置，并在末尾追加该节点，形成闭环路径。例如：

```txt
t1 -> t2 -> t3 -> t1
```

该路径写入 error 的 `details.cycle_path`，前端可直接展示。

#### 并发改写

并发改写只在 normalized plan 中体现，不改变原始请求。

算法：

1. 复制所有 tasks 为 normalized tasks。
2. 按 `parallel_group` 分组，未设置 parallel group 的任务不参与组内并发改写。
3. 每组按输入顺序排序。
4. 如果组内数量小于等于 `max_parallel_tasks`，不改写。
5. 如果超过限制，从第 `max_parallel_tasks + 1` 个任务开始，给当前任务追加同组前一个任务的 `task_id` 到 `depends_on`。
6. 给每个被改写任务追加 `normalization_notes`。
7. 为每个被改写的 group 返回 warning。
8. 对 normalized tasks 再执行一次 DAG 校验；如果改写后出现环路，返回 `normalized_dag_cycle` error。

该策略的优点是稳定、可解释、可测试；同样输入总能得到同样 normalized plan。

### 4.4 规则如何扩展

后续新增规则时优先新增 policy 函数，而不是修改 router。每个 policy 遵循相同输入输出：

```txt
PreflightContext -> PolicyResult
```

例如未来可以新增：

- tenant quota policy
- model context window policy
- sensitive data policy
- region routing policy
- retry cost estimation policy

规则编排由 `preflight_engine` 统一管理，最终集中计算 `decision`，避免不同 policy 直接修改最终状态。

### 4.5 边界条件如何处理

边界条件分两类处理：

- schema 级错误：字段类型错误、非法 enum、负数预算、`max_parallel_tasks < 1` 等，直接由 FastAPI/Pydantic 返回 422。
- plan 级错误：重复 `task_id`、missing skill、missing tool、unknown dependency、DAG cycle 等，返回 200 和 `decision=blocked`，便于前端用统一结果页展示。

重复 `task_id` 选择作为 plan 级 error，而不是 schema error，因为它属于计划内容合法性问题，用户需要在 Workbench 中看到具体阻断原因。

## 5. 前端设计

### 5.1 页面结构

前端采用独立 Vite React TypeScript 工程，页面路径为：

```txt
/admin/runtime/agent-run-preflight
```

建议目录结构：

```txt
frontend/
  src/
    api/
      preflightClient.ts
    hooks/
      usePreflight.ts
    fixtures/
      samplePreflightRequest.ts
    pages/
      AgentRunPreflightPage.tsx
    components/
      PreflightJsonEditor.tsx
      PreflightParameterPanel.tsx
      PreflightActions.tsx
      PreflightResultSummary.tsx
      PreflightIssueList.tsx
      PreflightNormalizedPlan.tsx
    types/
      preflight.ts
```

页面区域：

- JSON 输入区：展示和编辑完整请求 JSON，预置 sample。
- 参数区：单独展示并编辑 `environment`、`remaining_token_budget`、`max_parallel_tasks`。
- 操作区：`Load sample`、`Validate`、`Reset`。
- 结果区：状态 badge、Budget summary、Governance summary、Sandbox routes、Errors、Warnings、Audit notes、Normalized plan JSON。

### 5.2 状态流转

前端维护以下状态：

- `empty`：尚未执行预检，显示 sample 输入和空结果提示。
- `editing`：用户正在编辑 JSON 或参数，提示结果可能不是最新。
- `loading`：请求进行中，按钮 disabled，展示 loading 状态。
- `result`：后端返回成功响应，展示完整 Preflight result。
- `error`：本地 JSON 校验失败或接口请求失败。

典型流转：

```txt
empty -> editing -> loading -> result
empty -> editing -> error
result -> editing -> loading -> result
result -> editing -> error
```

### 5.3 client 或 hook 封装方式

请求逻辑封装在 `preflightClient.ts`：

```txt
runPreflight(request: PreflightRequest): Promise<PreflightResponse>
```

页面状态封装在 `usePreflight.ts`：

- 保存 JSON 文本、参数值、当前状态、错误信息和响应结果。
- 暴露 `loadSample`、`reset`、`validate`、`updateJsonText`、`updateParams`。
- `validate` 内先做本地 JSON parse，再调用 client。

这样页面组件只负责布局和渲染，不把请求、解析、状态管理和结果展示塞进一个大组件。

### 5.4 invalid JSON 的本地校验

用户点击 `Validate` 后，前端先执行：

```txt
JSON.parse(jsonText)
```

如果解析失败：

- 状态进入 `error`。
- 展示本地错误信息。
- 不调用后端接口。
- 保留用户当前输入，方便继续编辑。

参数区的 `environment`、`remaining_token_budget`、`max_parallel_tasks` 会覆盖 JSON 中对应字段，避免同一字段在两个位置编辑后不一致。

### 5.5 结果展示设计

结果区按排查优先级展示：

1. 总状态 badge：`ready`、`requires approval`、`blocked`。
2. Budget summary：estimated tokens、remaining after preflight、budget status。
3. Governance summary：highest action tier、approval required、approval reasons。
4. Sandbox routes：required、highest level、每个 route 的 task 和 reason。
5. Errors：阻断问题，突出展示。
6. Warnings：非阻断风险和改写说明。
7. Audit notes：本次预检执行过的步骤。
8. Normalized plan JSON：格式化展示，可用于研发调试。

视觉目标是清晰可用，不追求复杂控制台效果。页面应适合平台操作员快速判断，也能满足研发查看 normalized plan 的需求。

## 6. 测试设计

### 6.1 后端测试清单

后端使用 pytest + FastAPI TestClient，至少覆盖：

- ready happy path。
- missing skill blocked。
- inactive skill blocked。
- missing tool blocked。
- inactive tool blocked。
- tool deny blocked。
- tool ask requires approval。
- T3 skill requires approval。
- unknown dependency blocked。
- DAG cycle blocked，并返回 cycle path。
- budget exceeded blocked。
- parallel limit rewrite。
- prod sandbox upgrade。
- errors 优先级高于 approval。

重点断言：

- `decision`
- `can_execute`
- `errors[].code`
- `warnings[].code`
- `governance.approval_required`
- `governance.approval_reasons`
- `budget.budget_status`
- `sandbox.routes`
- `normalized_plan.tasks`

### 6.2 前端测试清单

前端使用 Vitest + React Testing Library，mock `fetch`，至少覆盖：

- 初始示例渲染。
- invalid JSON 不调用接口。
- ready 响应展示 ready。
- blocked 响应展示 errors。
- requires approval 响应展示 approval reasons。
- loading 状态。
- normalized plan 展示。

重点断言：

- 点击 `Validate` 时是否发起请求。
- invalid JSON 时 `fetch` 未被调用。
- loading 时按钮 disabled 或展示 loading 文案。
- 不同 decision badge 正确展示。
- errors、warnings、approval reasons、normalized plan 能被用户看到。

### 6.3 关键边界用例

除题目要求外，建议补充：

- 重复 `task_id` 返回 blocked。
- 空 tasks 由 schema 拦截。
- `max_parallel_tasks < 1` 由 schema 拦截。
- 负数 `remaining_token_budget` 由 schema 拦截。
- 负数 `estimated_tokens` 由 schema 拦截。
- prod 下 `L2/L3` 不降级也不重复 warning。
- missing Skill 和 missing Tool 可以在同一次响应中同时返回。

### 6.4 如何运行测试

实现后的运行命令如下：

```bash
cd backend
.venv/bin/python -m pytest
```

```bash
cd frontend
npm test
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

## 7. 风险与取舍

### 7.1 3-4 小时范围内的简化

本次实现聚焦可运行、可评审的工程切片，因此做以下简化：

- 使用请求体作为完整 plan snapshot，不查询数据库。
- Skill、Tool、Task 均以内存数据结构计算，不接外部 registry。
- 审批只计算原因，不创建审批单。
- Sandbox 只返回 route 建议，不创建真实隔离环境。
- Token 预算只做静态求和，不估算重试、工具调用和模型上下文开销。
- 并发改写采用简单稳定策略，不做复杂 DAG 优化。
- 前端使用单页调试台，不做完整后台导航、权限和历史记录。

### 7.2 如果进入生产，还需要补哪些能力

生产化需要补充：

- 接入 Skill Registry 和 Tool Registry，校验真实状态、版本和租户可见性。
- 将请求体中的 Skill/Tool snapshot 替换为后端 registry 查询结果，或增加 snapshot 版本校验，避免前端提交过期能力清单。
- 接入 Tenant Policy Center，让 `max_parallel_tasks`、sandbox 升级规则、审批规则可配置。
- 接入 Governance Approval Service，生成审批单并跟踪审批状态。
- 接入 Sandbox Scheduler，根据 route 创建真实运行环境。
- 接入 Audit Log，持久化请求、响应、操作者、时间和决策原因。
- 接入 AgentRun Orchestrator，让 normalized plan 成为执行链路的正式输入。
- 增加 SDK 契约和版本兼容策略，避免前后端或外部调用方字段漂移。
- 增加观测指标，例如 blocked rate、approval rate、budget exceeded rate。

### 7.3 哪些规则未来应该从配置、数据库或策略中心读取

应该从配置或策略中心读取的规则：

- 不同租户的 `max_parallel_tasks`。
- 不同环境的 Sandbox 升级规则。
- 不同 action tier 的审批策略。
- Tool exposure mode 和租户 allowlist / denylist。
- Skill 状态、版本、action tier 和 sandbox level。
- Token 预算阈值、预留比例和模型上下文限制。
- 特定环境或区域的执行限制。

本次以内置 policy 实现这些规则，是为了在有限时间内保持工程清晰和测试稳定。

## 8. 运行说明

### 8.1 后端启动

命令：

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

后端接口：

```txt
POST http://localhost:8000/api/v1/platform/runtime/agent-runs/preflight
```

健康检查：

```txt
GET http://localhost:8000/health
```

### 8.2 前端启动

命令：

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

前端页面：

```txt
http://localhost:5173/admin/runtime/agent-run-preflight
```

### 8.3 测试命令

命令：

```bash
cd backend
.venv/bin/python -m pytest
```

```bash
cd frontend
npm test
npm run typecheck
npm run build
npm audit --audit-level=moderate
```
