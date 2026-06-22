# Preflight Workbench 读结果指南

本文说明两类使用者如何阅读 [Agent Run Preflight Workbench](./agent-run-preflight-workbench.md) 的预检结果：

- **平台操作员**：30 秒内判断能否执行、下一步做什么。
- **研发调试人员**：对照 `normalized_plan` 排查计划结构与规则命中原因。

Workbench 结果区展示顺序与本文一致：状态 → Budget → Governance → Sandbox → Errors → Warnings → Audit notes → Normalized plan。

---

## 一、平台操作员：30 秒读结果

目标：**只回答三个问题**——能不能跑、卡在哪、下一步找谁。

### 第 1 步（5 秒）：看总状态

看结果区顶部的 **decision badge** 和 `can_execute`：

| decision | can_execute | 含义 | 下一步 |
|----------|-------------|------|--------|
| `ready` | `true` | 结构合法、预算够、无需审批 | 可以提交执行（调度器应使用 `normalized_plan`） |
| `requires_approval` | `false` | 无阻断错误，但需要人工审批 | 走审批流程，审批通过后再执行 |
| `blocked` | `false` | 存在至少一条 error | **不能执行**，必须先修计划 |

**优先级固定**：有 error 一定是 `blocked`，即使同时存在审批原因。不要看到 approval reasons 就以为「批完就能跑」。

### 第 2 步（10 秒）：看阻断与审批

**若 `blocked`**：直接展开 **Errors**，读每条 `message` 即可，不必看 JSON。

常见 error 与操作含义：

| code | 操作员怎么理解 | 典型处理 |
|------|----------------|----------|
| `missing_skill` / `missing_tool` | 计划引用了不存在的 Skill/Tool | 让计划提交方补 registry snapshot 或改 task 引用 |
| `inactive_skill` / `inactive_tool` | 资源存在但未激活 | 联系平台/能力 owner 激活，或换用其他 skill/tool |
| `tool_denied` | Tool 被策略禁止 | 换 tool 或申请策略例外 |
| `unknown_dependency` | 任务依赖了不存在的 task_id | 修正 `depends_on` |
| `dag_cycle` | 原始依赖成环 | 调整任务依赖，消除环路 |
| `duplicate_task_id` | 两个任务用了相同 ID | 改 task_id |
| `budget_exceeded` | 预估 token 超预算 | 减任务、降 `estimated_tokens`，或申请加预算 |
| `normalized_dag_cycle` | 并发改写后新依赖成环 | 需研发调整 `parallel_group` 或原始依赖（见第二节） |

**若 `requires_approval`**：看 **Governance → approval reasons**，例如：

- `skill xxx uses action_tier=T3` → 高风险 Skill，需治理审批
- `tool xxx uses exposure_mode=ask` → 敏感 Tool，需人工确认

**若 `ready`**：Errors 为空，Governance 里 `approval_required=false`，可继续看 Budget / Sandbox 做资源确认。

### 第 3 步（10 秒）：看资源与路由

按顺序扫一眼，确认执行环境是否匹配预期：

1. **Budget summary**
   - `budget_status=ok`：预算够用
   - `remaining_after_preflight`：跑完这批任务后还剩多少 token

2. **Sandbox routes**（尤其 `environment=prod`）
   - `sandbox.required=true`：至少有一个任务需要 Sandbox
   - `highest_level`：整批任务需要的最高 Sandbox 等级
   - 每条 route 的 `reason`：例如 prod 下 L0/L1 自动升到 L2

3. **Warnings**（非阻断，但必须知晓）
   - `prod_sandbox_upgrade`：生产环境 Sandbox 被升级
   - `parallel_limit_rewritten`：并发超限，计划已被改写为更串行的形态（执行侧应使用 `normalized_plan`）

Warnings **不会**把 decision 改成 `blocked`，但操作员应确认 Sandbox 容量、并发策略是否与 warning 一致。

### 第 4 步（5 秒）：记审计结论

看 **Audit notes**，确认预检跑完了哪些步骤，例如：

- `dag_validated` — 原始 DAG 校验完成
- `budget_prechecked` — 预算估算完成
- `parallel_plan_normalized` — 发生过并发改写
- `sandbox_route_estimated` — Sandbox 路由已估算
- `approval_required` — 需要审批

操作员通常**不需要**打开 Normalized plan JSON；只要 decision、errors、governance、sandbox 与 warnings 符合预期即可。

### 30 秒决策树（速查）

```txt
decision == blocked?
  └─ 是 → 读 Errors[0..n].message → 转交计划提交方 / 能力 owner 修复 → 结束
  └─ 否 → decision == requires_approval?
           └─ 是 → 读 approval_reasons → 发起审批 → 结束
           └─ 否 → decision == ready
                    └─ 扫 Budget(ok?) + Sandbox(等级可接受?) + Warnings(知晓即可)
                         └─ 可以执行（使用 normalized_plan）
```

---

## 二、研发调试：如何对照 normalized_plan 查问题

### 2.1 normalized_plan 是什么

`normalized_plan` 是 Preflight **在原始请求基础上做并发改写后的执行计划**。它与请求体中 `tasks` 的关系：

| 维度 | 原始 `tasks` | `normalized_plan.tasks` |
|------|--------------|-------------------------|
| 是否被 API 修改 | 请求快照，不变 | 响应产物，可能被追加依赖 |
| 何时与原始相同 | 无并发超限 | `depends_on` 与原始一致 |
| 何时不同 | 某 `parallel_group` 任务数 > `max_parallel_tasks` | 超额任务被追加同组前一个任务的依赖 |
| 额外字段 | 无 | 每项有 `normalization_notes[]` |

**调度器 / 执行器应使用 `normalized_plan`，而不是原始 `tasks`**，否则可能违反租户并发上限。

### 2.2 什么时候必须看 normalized_plan

| 场景 | 先看什么 | 为什么要看 normalized_plan |
|------|----------|----------------------------|
| warning `parallel_limit_rewritten` | Warnings.details.rewritten_task_ids | 确认哪些 task 被串行化 |
| error `normalized_dag_cycle` | errors.details.cycle_path | 改写引入了新环，需对照依赖 diff |
| decision=ready 但怀疑调度顺序不对 | 原始 tasks vs normalized | 确认实际执行 DAG |
| 复现「同输入是否同输出」 | 多次 Validate 的 normalized_plan | 改写策略必须稳定可复现 |

若 `audit_notes` **没有** `parallel_plan_normalized`，且 Warnings 无 `parallel_limit_rewritten`，则 `normalized_plan.tasks` 与请求 `tasks` 的 `depends_on` 应一致（仅多了空的 `normalization_notes`）。

### 2.3 对照步骤（推荐工作流）

#### Step A：并排打开两份 tasks

左：**请求 JSON** 的 `tasks`  
右：**响应** 的 `normalized_plan.tasks`

按 `task_id` 对齐，不要只看数组下标（duplicate task_id 时 index 会误导）。

#### Step B：逐 task 检查 diff 字段

对每个 task 检查：

1. **`depends_on` 是否变化**
   - 无变化 → 该 task 未被并发改写
   - 多了 dependency → 被改写，原因在 `normalization_notes`

2. **`normalization_notes` 是否非空**
   - 非空示例：`parallel_group g1 exceeds max_parallel_tasks=2; added dependency on t2`
   - 说明：组 `g1` 内该 task 因并发超限，被追加对 `t2` 的依赖

3. **其他字段**（`skill_id`、`tool_id`、`parallel_group`、`estimated_tokens`）  
   - 改写**不会**修改这些字段；若不一致，说明不是 Preflight 改写导致，应查前端/请求构造逻辑

#### Step C：用 warnings 交叉验证

`parallel_limit_rewritten` warning 的 `details` 结构：

```json
{
  "parallel_group": "g1",
  "max_parallel_tasks": 2,
  "rewritten_task_ids": ["t3", "t4"]
}
```

研发应验证：`rewritten_task_ids` 里每个 task 在 normalized_plan 中：

- `depends_on` 比原始多一个同组前一个 task
- `normalization_notes` 有一条对应说明

#### Step D：用 audit_notes 确认执行路径

| audit_note | 含义 |
|------------|------|
| `parallel_plan_normalized` | 至少有一个 parallel group 被改写 |
| 无此项 | normalized_plan 与原始 depends_on 一致 |

#### Step E：DAG 相关 error 的对照

**`dag_cycle`（原始环）**

- 查原始 `tasks[].depends_on`
- 用 `errors[].details.cycle_path` 定位环，例如 `["t1","t2","t1"]`
- 此时 normalized_plan 通常仍有改写结果，但 decision 已是 blocked

**`normalized_dag_cycle`（改写后环）**

- 原始 DAG 可能无环，但改写后的依赖与原有依赖组合成环
- 对照方式：
  1. 看 warning 里哪个 `parallel_group` 被改写
  2. 看 `cycle_path` 涉及哪些 task
  3. 检查这些 task 的**原始** `depends_on` 是否与**新增**的同组依赖冲突

典型修复方向：

- 把冲突 task 拆到不同 `parallel_group`
- 调整原始 `depends_on`，使改写后仍无环
- 提高 `max_parallel_tasks`（若租户策略允许）

### 2.4 并发改写对照示例

**输入**

```txt
max_parallel_tasks = 2
parallel_group g1 = [t1, t2, t3, t4]   # 按 tasks 数组顺序
```

**原始 depends_on**（假设都无依赖）

```txt
t1: []
t2: []
t3: []
t4: []
```

**normalized_plan depends_on**

```txt
t1: []           # 组内第 1 个，保持
t2: []           # 组内第 2 个，保持
t3: [t2]         # 第 3 个，追加 t2
t4: [t3]         # 第 4 个，追加 t3
```

**研发检查清单**

- [ ] t3、t4 的 `normalization_notes` 各有一条
- [ ] warning `parallel_limit_rewritten` 的 `rewritten_task_ids` 为 `["t3","t4"]`
- [ ] `audit_notes` 含 `parallel_plan_normalized`
- [ ] 对 normalized tasks 再跑 mentally：无 `normalized_dag_cycle`

### 2.5 与 Errors / Warnings / Governance 的对照表

研发排查时，issue 类型决定去哪对照：

| 问题类型 | 主要字段 | 是否对照 normalized_plan |
|----------|----------|--------------------------|
| Skill/Tool 引用 | errors + field `tasks[n].skill_id` | 否，与 plan 结构无关 |
| 原始 DAG | errors `dag_cycle` + cycle_path | 可选，看原始 tasks |
| 改写后 DAG | errors `normalized_dag_cycle` | **必须** |
| 并发超限 | warnings `parallel_limit_rewritten` | **必须** |
| 预算 | errors `budget_exceeded` + budget | 否（只看 estimated_tokens 求和） |
| 审批 | governance.approval_reasons | 否 |
| Sandbox | sandbox.routes + warnings | 否（基于原始 task + skill） |

### 2.6 稳定可复现性检查

Preflight 要求：**相同请求 → 相同 normalized_plan**。

研发自测：

1. 固定请求 JSON，连续 Validate 两次
2. 比较两次响应的 `normalized_plan.tasks`（尤其 `depends_on` 与 `normalization_notes`）
3. 调整 `tasks` 顺序但保持同一 parallel group 成员 → 改写结果应随**输入顺序**变化（策略按输入顺序取前 N 个并行）

---

## 三、两类使用者协作方式

```txt
操作员                          研发
  │                              │
  ├─ blocked + dag_cycle ───────► 修 depends_on
  ├─ blocked + missing_tool ────► 补 tools snapshot 或改引用
  ├─ requires_approval ─────────► 确认 T3/ask 是否合理
  ├─ ready + parallel warning ──► 确认 normalized_plan 可接受
  └─ blocked + normalized_dag ──► 调整 parallel_group / 原始依赖
```

操作员把 **decision + errors/warnings 的 message** 贴给研发即可；研发用本文第二节对照 `normalized_plan` 定位结构问题。

---

## 四、相关文档

- [Agent Run Preflight Workbench 需求与设计](./agent-run-preflight-workbench.md)
- 并发改写规则：主文档 §2.5、§4.3
- 响应 schema 示例：主文档 §3.3
