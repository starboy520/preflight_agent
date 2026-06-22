# Agent Run Preflight Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable standalone FastAPI + React workbench for validating AgentRun preflight plans before execution.

**Architecture:** The backend exposes one FastAPI endpoint and keeps all business rules in focused domain policy functions. The request body carries the Skill and Tool registry snapshot for this preflight run; the backend does not maintain a fixed built-in Skill/Tool whitelist. The frontend is a Vite React TypeScript app with a JSON editor, parameter controls, request hook, and structured result panels. Tests cover required backend rules, frontend states, and the normalized-plan DAG revalidation enhancement.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, pytest, httpx, Vite, React, TypeScript, Vitest, React Testing Library.

---

## File Structure

Create or modify the following files.

```txt
backend/
  requirements.txt
  app/
    __init__.py
    main.py
    api/
      __init__.py
      preflight.py
    schemas/
      __init__.py
      preflight.py
    services/
      __init__.py
      preflight_service.py
    domain/
      __init__.py
      policies.py
      preflight_engine.py
  tests/
    test_agent_run_preflight.py

frontend/
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    styles.css
    api/
      preflightClient.ts
    components/
      PreflightActions.tsx
      PreflightIssueList.tsx
      PreflightJsonEditor.tsx
      PreflightNormalizedPlan.tsx
      PreflightParameterPanel.tsx
      PreflightResultSummary.tsx
    fixtures/
      samplePreflightRequest.ts
    hooks/
      usePreflight.ts
    pages/
      AgentRunPreflightPage.test.tsx
      AgentRunPreflightPage.tsx
    test/
      setup.ts
    types/
      preflight.ts

docs/
  agent-run-preflight-workbench.md
README.md
```

The current workspace is not a git repository, so each task ends with a local verification checkpoint instead of a commit. If git is initialized later, commit after each task using the task title as the commit message.

Implementation boundary: use `request.skills` and `request.tools` as the available Skill/Tool registry snapshot. A task references a missing Skill or Tool only when the referenced ID is absent from that request snapshot.

---

### Task 1: Backend Contract Tests

**Files:**
- Create: `backend/tests/test_agent_run_preflight.py`

- [ ] **Step 1: Write the backend API tests first**

Create `backend/tests/test_agent_run_preflight.py` with this complete content:

```python
from copy import deepcopy

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


BASE_REQUEST = {
    "thread_id": "thd-001",
    "environment": "dev",
    "remaining_token_budget": 9000,
    "max_parallel_tasks": 2,
    "skills": [
        {
            "skill_id": "knowledge.search",
            "status": "active",
            "action_tier": "T1",
            "sandbox_level": "none",
        },
        {
            "skill_id": "report.generate",
            "status": "active",
            "action_tier": "T2",
            "sandbox_level": "L1",
        },
    ],
    "tools": [
        {
            "tool_id": "web.search",
            "status": "active",
            "exposure_mode": "allow",
        },
        {
            "tool_id": "artifact.write",
            "status": "active",
            "exposure_mode": "allow",
        },
    ],
    "tasks": [
        {
            "task_id": "t1",
            "title": "Search source material",
            "skill_id": "knowledge.search",
            "tool_id": "web.search",
            "depends_on": [],
            "estimated_tokens": 1800,
            "parallel_group": "g1",
        },
        {
            "task_id": "t2",
            "title": "Generate report",
            "skill_id": "report.generate",
            "tool_id": "artifact.write",
            "depends_on": ["t1"],
            "estimated_tokens": 3200,
            "parallel_group": "g1",
        },
    ],
}


def request_copy():
    return deepcopy(BASE_REQUEST)


def post_preflight(payload):
    return client.post("/api/v1/platform/runtime/agent-runs/preflight", json=payload)


def issue_codes(response_body, key="errors"):
    return [item["code"] for item in response_body[key]]


def test_ready_happy_path():
    response = post_preflight(request_copy())

    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "ready"
    assert body["can_execute"] is True
    assert body["budget"]["estimated_tokens"] == 5000
    assert body["budget"]["remaining_after_preflight"] == 4000
    assert body["budget"]["budget_status"] == "ok"
    assert body["governance"]["approval_required"] is False
    assert body["errors"] == []
    assert "dag_validated" in body["audit_notes"]


def test_missing_skill_blocks():
    payload = request_copy()
    payload["tasks"][0]["skill_id"] = "missing.skill"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert body["can_execute"] is False
    assert "missing_skill" in issue_codes(body)


def test_inactive_skill_blocks():
    payload = request_copy()
    payload["skills"][0]["status"] = "inactive"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "inactive_skill" in issue_codes(body)


def test_missing_tool_blocks():
    payload = request_copy()
    payload["tasks"][0]["tool_id"] = "missing.tool"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "missing_tool" in issue_codes(body)


def test_inactive_tool_blocks():
    payload = request_copy()
    payload["tools"][0]["status"] = "inactive"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "inactive_tool" in issue_codes(body)


def test_tool_deny_blocks():
    payload = request_copy()
    payload["tools"][0]["exposure_mode"] = "deny"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "tool_denied" in issue_codes(body)


def test_tool_ask_requires_approval():
    payload = request_copy()
    payload["tools"][1]["exposure_mode"] = "ask"

    body = post_preflight(payload).json()

    assert body["decision"] == "requires_approval"
    assert body["can_execute"] is False
    assert body["governance"]["approval_required"] is True
    assert "tool artifact.write uses exposure_mode=ask" in body["governance"]["approval_reasons"]


def test_t3_skill_requires_approval():
    payload = request_copy()
    payload["skills"][1]["action_tier"] = "T3"

    body = post_preflight(payload).json()

    assert body["decision"] == "requires_approval"
    assert body["governance"]["approval_required"] is True
    assert "skill report.generate uses action_tier=T3" in body["governance"]["approval_reasons"]


def test_unknown_dependency_blocks():
    payload = request_copy()
    payload["tasks"][1]["depends_on"] = ["unknown-task"]

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "unknown_dependency" in issue_codes(body)


def test_dag_cycle_blocks_and_returns_cycle_path():
    payload = request_copy()
    payload["tasks"][0]["depends_on"] = ["t2"]
    payload["tasks"][1]["depends_on"] = ["t1"]

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "dag_cycle" in issue_codes(body)
    cycle_error = next(item for item in body["errors"] if item["code"] == "dag_cycle")
    assert cycle_error["details"]["cycle_path"] == ["t1", "t2", "t1"]


def test_budget_exceeded_blocks():
    payload = request_copy()
    payload["remaining_token_budget"] = 100

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert body["budget"]["budget_status"] == "exceeded"
    assert "budget_exceeded" in issue_codes(body)


def test_parallel_limit_rewrite_adds_stable_dependency():
    payload = request_copy()
    payload["tasks"].append(
        {
            "task_id": "t3",
            "title": "Review report",
            "skill_id": "report.generate",
            "tool_id": "artifact.write",
            "depends_on": [],
            "estimated_tokens": 1000,
            "parallel_group": "g1",
        }
    )

    body = post_preflight(payload).json()

    assert body["decision"] == "ready"
    assert "parallel_limit_rewritten" in issue_codes(body, "warnings")
    normalized_t3 = next(task for task in body["normalized_plan"]["tasks"] if task["task_id"] == "t3")
    assert normalized_t3["depends_on"] == ["t2"]
    assert normalized_t3["normalization_notes"] == [
        "parallel_group g1 exceeds max_parallel_tasks=2; added dependency on t2"
    ]


def test_prod_sandbox_upgrade_warns_and_routes_to_l2():
    payload = request_copy()
    payload["environment"] = "prod"

    body = post_preflight(payload).json()

    assert body["decision"] == "ready"
    assert "prod_sandbox_upgrade" in issue_codes(body, "warnings")
    assert body["sandbox"]["required"] is True
    assert body["sandbox"]["highest_level"] == "L2"
    assert body["sandbox"]["routes"] == [
        {
            "task_id": "t2",
            "sandbox_level": "L2",
            "reason": "prod environment upgrades L1 sandbox to L2",
        }
    ]


def test_errors_take_priority_over_approval():
    payload = request_copy()
    payload["tasks"][0]["skill_id"] = "missing.skill"
    payload["tools"][1]["exposure_mode"] = "ask"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert body["governance"]["approval_required"] is True
    assert "missing_skill" in issue_codes(body)


def test_duplicate_task_id_blocks():
    payload = request_copy()
    payload["tasks"][1]["task_id"] = "t1"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "duplicate_task_id" in issue_codes(body)


def test_normalized_dag_cycle_blocks_when_rewrite_creates_cycle():
    payload = request_copy()
    payload["max_parallel_tasks"] = 1
    payload["tasks"][0]["depends_on"] = ["t2"]
    payload["tasks"][1]["depends_on"] = []

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "normalized_dag_cycle" in issue_codes(body)
    cycle_error = next(item for item in body["errors"] if item["code"] == "normalized_dag_cycle")
    assert cycle_error["details"]["cycle_path"] == ["t1", "t2", "t1"]
```

- [ ] **Step 2: Run the tests to verify the expected initial failure**

Run:

```bash
cd backend
python -m pytest tests/test_agent_run_preflight.py -q
```

Expected: failure because the FastAPI app and implementation modules do not exist yet.

---

### Task 2: Backend Schemas and FastAPI Route

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/app/api/__init__.py`
- Create: `backend/app/api/preflight.py`
- Create: `backend/app/schemas/__init__.py`
- Create: `backend/app/schemas/preflight.py`
- Create: `backend/app/services/__init__.py`
- Create: `backend/app/services/preflight_service.py`

- [ ] **Step 1: Add backend dependencies**

Create `backend/requirements.txt`:

```txt
fastapi>=0.115,<1.0
uvicorn[standard]>=0.32,<1.0
pydantic>=2.10,<3.0
pytest>=8.0,<9.0
httpx>=0.27,<1.0
```

- [ ] **Step 2: Add package marker files**

Create these empty files:

```txt
backend/app/__init__.py
backend/app/api/__init__.py
backend/app/schemas/__init__.py
backend/app/services/__init__.py
```

- [ ] **Step 3: Add Pydantic schemas**

Create `backend/app/schemas/preflight.py`:

```python
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


Environment = Literal["dev", "staging", "prod"]
ResourceStatus = Literal["active", "inactive", "disabled"]
ActionTier = Literal["T1", "T2", "T3"]
HighestActionTier = Literal["none", "T1", "T2", "T3"]
SandboxLevel = Literal["none", "L0", "L1", "L2", "L3"]
ExposureMode = Literal["allow", "ask", "deny"]
Decision = Literal["blocked", "requires_approval", "ready"]
BudgetStatus = Literal["ok", "exceeded"]


class SkillRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(..., min_length=1)
    status: ResourceStatus
    action_tier: ActionTier
    sandbox_level: SandboxLevel


class ToolRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool_id: str = Field(..., min_length=1)
    status: ResourceStatus
    exposure_mode: ExposureMode


class TaskPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    skill_id: str = Field(..., min_length=1)
    tool_id: str = Field(..., min_length=1)
    depends_on: list[str] = Field(default_factory=list)
    estimated_tokens: int = Field(..., ge=0)
    parallel_group: str | None = None


class PreflightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str = Field(..., min_length=1)
    environment: Environment
    remaining_token_budget: int = Field(..., ge=0)
    max_parallel_tasks: int = Field(..., ge=1)
    skills: list[SkillRef] = Field(default_factory=list)
    tools: list[ToolRef] = Field(default_factory=list)
    tasks: list[TaskPlan] = Field(..., min_length=1)


class PreflightIssue(BaseModel):
    code: str
    message: str
    field: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class NormalizedTask(BaseModel):
    task_id: str
    title: str
    skill_id: str
    tool_id: str
    depends_on: list[str] = Field(default_factory=list)
    estimated_tokens: int
    parallel_group: str | None = None
    normalization_notes: list[str] = Field(default_factory=list)


class NormalizedPlan(BaseModel):
    tasks: list[NormalizedTask] = Field(default_factory=list)


class BudgetSummary(BaseModel):
    estimated_tokens: int
    remaining_after_preflight: int
    budget_status: BudgetStatus


class GovernanceSummary(BaseModel):
    highest_action_tier: HighestActionTier
    approval_required: bool
    approval_reasons: list[str] = Field(default_factory=list)


class SandboxRoute(BaseModel):
    task_id: str
    sandbox_level: SandboxLevel
    reason: str


class SandboxSummary(BaseModel):
    required: bool
    highest_level: SandboxLevel
    routes: list[SandboxRoute] = Field(default_factory=list)


class PreflightResponse(BaseModel):
    decision: Decision
    can_execute: bool
    normalized_plan: NormalizedPlan
    budget: BudgetSummary
    governance: GovernanceSummary
    sandbox: SandboxSummary
    errors: list[PreflightIssue] = Field(default_factory=list)
    warnings: list[PreflightIssue] = Field(default_factory=list)
    audit_notes: list[str] = Field(default_factory=list)
```

- [ ] **Step 4: Add service wrapper**

Create `backend/app/services/preflight_service.py`:

```python
from app.domain.preflight_engine import run_preflight
from app.schemas.preflight import PreflightRequest, PreflightResponse


def evaluate_preflight(request: PreflightRequest) -> PreflightResponse:
    return run_preflight(request)
```

- [ ] **Step 5: Add FastAPI route**

Create `backend/app/api/preflight.py`:

```python
from fastapi import APIRouter

from app.schemas.preflight import PreflightRequest, PreflightResponse
from app.services.preflight_service import evaluate_preflight

router = APIRouter(prefix="/api/v1/platform/runtime/agent-runs", tags=["agent-run-preflight"])


@router.post("/preflight", response_model=PreflightResponse)
def preflight_agent_run(request: PreflightRequest) -> PreflightResponse:
    return evaluate_preflight(request)
```

- [ ] **Step 6: Add FastAPI app entrypoint**

Create `backend/app/main.py`:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.preflight import router as preflight_router


app = FastAPI(title="Agent Run Preflight Workbench")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(preflight_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 7: Run tests to verify the next failure**

Run:

```bash
cd backend
python -m pytest tests/test_agent_run_preflight.py -q
```

Expected: failure because `app.domain.preflight_engine` does not exist yet.

---

### Task 3: Backend Domain Policies and Engine

**Files:**
- Create: `backend/app/domain/__init__.py`
- Create: `backend/app/domain/policies.py`
- Create: `backend/app/domain/preflight_engine.py`

- [ ] **Step 1: Add package marker**

Create an empty file:

```txt
backend/app/domain/__init__.py
```

- [ ] **Step 2: Add domain policy functions**

Create `backend/app/domain/policies.py`:

```python
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from app.schemas.preflight import (
    BudgetSummary,
    GovernanceSummary,
    NormalizedPlan,
    NormalizedTask,
    PreflightIssue,
    PreflightRequest,
    SandboxRoute,
    SandboxSummary,
    SandboxLevel,
    TaskPlan,
)


TIER_RANK = {"none": 0, "T1": 1, "T2": 2, "T3": 3}
SANDBOX_RANK = {"none": 0, "L0": 1, "L1": 2, "L2": 3, "L3": 4}


@dataclass
class ValidationResult:
    errors: list[PreflightIssue] = field(default_factory=list)
    warnings: list[PreflightIssue] = field(default_factory=list)
    approval_reasons: list[str] = field(default_factory=list)
    audit_notes: list[str] = field(default_factory=list)


def issue(code: str, message: str, field: str | None = None, **details: object) -> PreflightIssue:
    return PreflightIssue(code=code, message=message, field=field, details=details)


def task_index(tasks: Iterable[TaskPlan | NormalizedTask]) -> dict[str, TaskPlan | NormalizedTask]:
    return {task.task_id: task for task in tasks}


def validate_duplicate_task_ids(tasks: list[TaskPlan]) -> list[PreflightIssue]:
    seen: set[str] = set()
    duplicates: list[PreflightIssue] = []
    for index, task in enumerate(tasks):
        if task.task_id in seen:
            duplicates.append(
                issue(
                    "duplicate_task_id",
                    f"task_id {task.task_id} appears more than once",
                    f"tasks[{index}].task_id",
                    task_id=task.task_id,
                )
            )
        seen.add(task.task_id)
    return duplicates


def validate_skills(request: PreflightRequest) -> ValidationResult:
    result = ValidationResult()
    skills = {skill.skill_id: skill for skill in request.skills}

    for index, skill in enumerate(request.skills):
        if skill.status != "active":
            result.errors.append(
                issue(
                    "inactive_skill",
                    f"skill {skill.skill_id} has status={skill.status}",
                    f"skills[{index}].status",
                    skill_id=skill.skill_id,
                    status=skill.status,
                )
            )
        if skill.action_tier == "T3":
            result.approval_reasons.append(f"skill {skill.skill_id} uses action_tier=T3")

    for index, task in enumerate(request.tasks):
        if task.skill_id not in skills:
            result.errors.append(
                issue(
                    "missing_skill",
                    f"task {task.task_id} references missing skill {task.skill_id}",
                    f"tasks[{index}].skill_id",
                    task_id=task.task_id,
                    skill_id=task.skill_id,
                )
            )

    return result


def validate_tools(request: PreflightRequest) -> ValidationResult:
    result = ValidationResult()
    tools = {tool.tool_id: tool for tool in request.tools}

    for index, tool in enumerate(request.tools):
        if tool.status != "active":
            result.errors.append(
                issue(
                    "inactive_tool",
                    f"tool {tool.tool_id} has status={tool.status}",
                    f"tools[{index}].status",
                    tool_id=tool.tool_id,
                    status=tool.status,
                )
            )
        if tool.exposure_mode == "deny":
            result.errors.append(
                issue(
                    "tool_denied",
                    f"tool {tool.tool_id} uses exposure_mode=deny",
                    f"tools[{index}].exposure_mode",
                    tool_id=tool.tool_id,
                    exposure_mode=tool.exposure_mode,
                )
            )
        if tool.exposure_mode == "ask":
            result.approval_reasons.append(f"tool {tool.tool_id} uses exposure_mode=ask")

    for index, task in enumerate(request.tasks):
        if task.tool_id not in tools:
            result.errors.append(
                issue(
                    "missing_tool",
                    f"task {task.task_id} references missing tool {task.tool_id}",
                    f"tasks[{index}].tool_id",
                    task_id=task.task_id,
                    tool_id=task.tool_id,
                )
            )

    return result


def detect_cycle(tasks: list[TaskPlan | NormalizedTask]) -> list[str] | None:
    tasks_by_id = task_index(tasks)
    colors = {task.task_id: "unvisited" for task in tasks}
    path: list[str] = []

    def visit(task_id: str) -> list[str] | None:
        colors[task_id] = "visiting"
        path.append(task_id)

        for dependency_id in tasks_by_id[task_id].depends_on:
            if dependency_id not in tasks_by_id:
                continue
            if colors[dependency_id] == "visiting":
                start = path.index(dependency_id)
                return path[start:] + [dependency_id]
            if colors[dependency_id] == "unvisited":
                cycle = visit(dependency_id)
                if cycle:
                    return cycle

        path.pop()
        colors[task_id] = "visited"
        return None

    for task in tasks:
        if colors[task.task_id] == "unvisited":
            cycle = visit(task.task_id)
            if cycle:
                return cycle
    return None


def validate_dag(
    tasks: list[TaskPlan | NormalizedTask],
    *,
    cycle_code: str = "dag_cycle",
    unknown_dependency_code: str = "unknown_dependency",
) -> list[PreflightIssue]:
    errors: list[PreflightIssue] = []
    tasks_by_id = task_index(tasks)

    for index, task in enumerate(tasks):
        for dependency_id in task.depends_on:
            if dependency_id not in tasks_by_id:
                errors.append(
                    issue(
                        unknown_dependency_code,
                        f"task {task.task_id} depends on unknown task {dependency_id}",
                        f"tasks[{index}].depends_on",
                        task_id=task.task_id,
                        dependency_id=dependency_id,
                    )
                )

    cycle = detect_cycle(tasks)
    if cycle:
        errors.append(
            issue(
                cycle_code,
                f"dependency cycle detected: {' -> '.join(cycle)}",
                "tasks.depends_on",
                cycle_path=cycle,
            )
        )

    return errors


def evaluate_budget(request: PreflightRequest) -> tuple[BudgetSummary, list[PreflightIssue]]:
    estimated_tokens = sum(task.estimated_tokens for task in request.tasks)
    remaining_after = request.remaining_token_budget - estimated_tokens
    status = "ok" if remaining_after >= 0 else "exceeded"
    errors: list[PreflightIssue] = []

    if status == "exceeded":
        errors.append(
            issue(
                "budget_exceeded",
                f"estimated tokens {estimated_tokens} exceed remaining budget {request.remaining_token_budget}",
                "remaining_token_budget",
                estimated_tokens=estimated_tokens,
                remaining_token_budget=request.remaining_token_budget,
            )
        )

    return (
        BudgetSummary(
            estimated_tokens=estimated_tokens,
            remaining_after_preflight=remaining_after,
            budget_status=status,
        ),
        errors,
    )


def normalize_parallel_plan(request: PreflightRequest) -> tuple[NormalizedPlan, list[PreflightIssue]]:
    normalized_tasks = [
        NormalizedTask(**task.model_dump(), normalization_notes=[])
        for task in request.tasks
    ]
    grouped: dict[str, list[NormalizedTask]] = defaultdict(list)
    warnings: list[PreflightIssue] = []

    for task in normalized_tasks:
        if task.parallel_group:
            grouped[task.parallel_group].append(task)

    for group_id, group_tasks in grouped.items():
        if len(group_tasks) <= request.max_parallel_tasks:
            continue

        for index in range(request.max_parallel_tasks, len(group_tasks)):
            current = group_tasks[index]
            previous = group_tasks[index - 1]
            if previous.task_id not in current.depends_on:
                current.depends_on.append(previous.task_id)
            current.normalization_notes.append(
                f"parallel_group {group_id} exceeds max_parallel_tasks={request.max_parallel_tasks}; "
                f"added dependency on {previous.task_id}"
            )

        warnings.append(
            issue(
                "parallel_limit_rewritten",
                f"parallel_group {group_id} has {len(group_tasks)} tasks and was normalized to max_parallel_tasks={request.max_parallel_tasks}",
                "tasks.parallel_group",
                parallel_group=group_id,
                task_count=len(group_tasks),
                max_parallel_tasks=request.max_parallel_tasks,
            )
        )

    return NormalizedPlan(tasks=normalized_tasks), warnings


def highest_action_tier(request: PreflightRequest) -> str:
    highest = "none"
    for skill in request.skills:
        if TIER_RANK[skill.action_tier] > TIER_RANK[highest]:
            highest = skill.action_tier
    return highest


def evaluate_governance(request: PreflightRequest, approval_reasons: list[str]) -> GovernanceSummary:
    unique_reasons = list(dict.fromkeys(approval_reasons))
    return GovernanceSummary(
        highest_action_tier=highest_action_tier(request),
        approval_required=bool(unique_reasons),
        approval_reasons=unique_reasons,
    )


def evaluate_sandbox(request: PreflightRequest) -> tuple[SandboxSummary, list[PreflightIssue]]:
    skills = {skill.skill_id: skill for skill in request.skills}
    routes: list[SandboxRoute] = []
    warnings: list[PreflightIssue] = []
    highest: SandboxLevel = "none"

    for task_index_value, task in enumerate(request.tasks):
        skill = skills.get(task.skill_id)
        if not skill or skill.sandbox_level == "none":
            continue

        original_level = skill.sandbox_level
        effective_level: SandboxLevel = original_level
        reason = f"skill {skill.skill_id} requires sandbox_level={original_level}"

        if request.environment == "prod" and original_level in {"L0", "L1"}:
            effective_level = "L2"
            reason = f"prod environment upgrades {original_level} sandbox to L2"
            warnings.append(
                issue(
                    "prod_sandbox_upgrade",
                    f"task {task.task_id} sandbox level upgraded from {original_level} to L2 in prod",
                    f"tasks[{task_index_value}].skill_id",
                    task_id=task.task_id,
                    from_level=original_level,
                    to_level="L2",
                )
            )

        routes.append(SandboxRoute(task_id=task.task_id, sandbox_level=effective_level, reason=reason))

        if SANDBOX_RANK[effective_level] > SANDBOX_RANK[highest]:
            highest = effective_level

    return SandboxSummary(required=bool(routes), highest_level=highest, routes=routes), warnings
```

- [ ] **Step 3: Add engine orchestration**

Create `backend/app/domain/preflight_engine.py`:

```python
from app.domain.policies import (
    evaluate_budget,
    evaluate_governance,
    evaluate_sandbox,
    normalize_parallel_plan,
    validate_dag,
    validate_duplicate_task_ids,
    validate_skills,
    validate_tools,
)
from app.schemas.preflight import PreflightRequest, PreflightResponse


def run_preflight(request: PreflightRequest) -> PreflightResponse:
    errors = []
    warnings = []
    approval_reasons = []
    audit_notes: list[str] = []

    duplicate_errors = validate_duplicate_task_ids(request.tasks)
    errors.extend(duplicate_errors)

    skill_result = validate_skills(request)
    tool_result = validate_tools(request)
    errors.extend(skill_result.errors)
    errors.extend(tool_result.errors)
    approval_reasons.extend(skill_result.approval_reasons)
    approval_reasons.extend(tool_result.approval_reasons)

    original_dag_errors = validate_dag(request.tasks)
    errors.extend(original_dag_errors)
    if not original_dag_errors:
        audit_notes.append("dag_validated")

    budget, budget_errors = evaluate_budget(request)
    errors.extend(budget_errors)
    audit_notes.append("budget_prechecked")

    normalized_plan, normalization_warnings = normalize_parallel_plan(request)
    warnings.extend(normalization_warnings)
    if normalization_warnings:
        audit_notes.append("parallel_plan_normalized")

    if not duplicate_errors and not original_dag_errors:
        normalized_dag_errors = validate_dag(
            normalized_plan.tasks,
            cycle_code="normalized_dag_cycle",
            unknown_dependency_code="normalized_unknown_dependency",
        )
        errors.extend(normalized_dag_errors)

    sandbox, sandbox_warnings = evaluate_sandbox(request)
    warnings.extend(sandbox_warnings)
    audit_notes.append("sandbox_route_estimated")

    governance = evaluate_governance(request, approval_reasons)
    if governance.approval_required:
        audit_notes.append("approval_required")

    if errors:
        decision = "blocked"
        can_execute = False
    elif governance.approval_required:
        decision = "requires_approval"
        can_execute = False
    else:
        decision = "ready"
        can_execute = True
        audit_notes.append("ready_for_execution")

    return PreflightResponse(
        decision=decision,
        can_execute=can_execute,
        normalized_plan=normalized_plan,
        budget=budget,
        governance=governance,
        sandbox=sandbox,
        errors=errors,
        warnings=warnings,
        audit_notes=list(dict.fromkeys(audit_notes)),
    )
```

- [ ] **Step 4: Run backend tests**

Run:

```bash
cd backend
python -m pytest tests/test_agent_run_preflight.py -q
```

Expected: all backend tests pass.

---

### Task 4: Frontend Project Scaffold and Types

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/types/preflight.ts`
- Create: `frontend/src/fixtures/samplePreflightRequest.ts`

- [ ] **Step 1: Add frontend package scripts and dependencies**

Create `frontend/package.json`:

```json
{
  "name": "agent-run-preflight-workbench",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^5.4.11",
    "typescript": "^5.6.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "jsdom": "^25.0.1",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `frontend/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Node",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 3: Add Vite config**

Create `frontend/vite.config.ts`:

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true
  },
  server: {
    port: 5173
  }
});
```

- [ ] **Step 4: Add HTML shell**

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent Run Preflight Workbench</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Add frontend types**

Create `frontend/src/types/preflight.ts`:

```typescript
export type Environment = "dev" | "staging" | "prod";
export type ResourceStatus = "active" | "inactive" | "disabled";
export type ActionTier = "T1" | "T2" | "T3";
export type SandboxLevel = "none" | "L0" | "L1" | "L2" | "L3";
export type ExposureMode = "allow" | "ask" | "deny";
export type Decision = "blocked" | "requires_approval" | "ready";
export type BudgetStatus = "ok" | "exceeded";

export interface SkillRef {
  skill_id: string;
  status: ResourceStatus;
  action_tier: ActionTier;
  sandbox_level: SandboxLevel;
}

export interface ToolRef {
  tool_id: string;
  status: ResourceStatus;
  exposure_mode: ExposureMode;
}

export interface TaskPlan {
  task_id: string;
  title: string;
  skill_id: string;
  tool_id: string;
  depends_on: string[];
  estimated_tokens: number;
  parallel_group?: string | null;
}

export interface PreflightRequest {
  thread_id: string;
  environment: Environment;
  remaining_token_budget: number;
  max_parallel_tasks: number;
  skills: SkillRef[];
  tools: ToolRef[];
  tasks: TaskPlan[];
}

export interface PreflightIssue {
  code: string;
  message: string;
  field?: string | null;
  details: Record<string, unknown>;
}

export interface NormalizedTask extends TaskPlan {
  normalization_notes: string[];
}

export interface NormalizedPlan {
  tasks: NormalizedTask[];
}

export interface BudgetSummary {
  estimated_tokens: number;
  remaining_after_preflight: number;
  budget_status: BudgetStatus;
}

export interface GovernanceSummary {
  highest_action_tier: "none" | ActionTier;
  approval_required: boolean;
  approval_reasons: string[];
}

export interface SandboxRoute {
  task_id: string;
  sandbox_level: SandboxLevel;
  reason: string;
}

export interface SandboxSummary {
  required: boolean;
  highest_level: SandboxLevel;
  routes: SandboxRoute[];
}

export interface PreflightResponse {
  decision: Decision;
  can_execute: boolean;
  normalized_plan: NormalizedPlan;
  budget: BudgetSummary;
  governance: GovernanceSummary;
  sandbox: SandboxSummary;
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  audit_notes: string[];
}
```

- [ ] **Step 6: Add sample request fixture**

Create `frontend/src/fixtures/samplePreflightRequest.ts`:

```typescript
import type { PreflightRequest } from "../types/preflight";

export const samplePreflightRequest: PreflightRequest = {
  thread_id: "thd-001",
  environment: "prod",
  remaining_token_budget: 9000,
  max_parallel_tasks: 2,
  skills: [
    {
      skill_id: "knowledge.search",
      status: "active",
      action_tier: "T1",
      sandbox_level: "none"
    },
    {
      skill_id: "report.generate",
      status: "active",
      action_tier: "T2",
      sandbox_level: "L1"
    }
  ],
  tools: [
    {
      tool_id: "web.search",
      status: "active",
      exposure_mode: "allow"
    },
    {
      tool_id: "artifact.write",
      status: "active",
      exposure_mode: "ask"
    }
  ],
  tasks: [
    {
      task_id: "t1",
      title: "Search source material",
      skill_id: "knowledge.search",
      tool_id: "web.search",
      depends_on: [],
      estimated_tokens: 1800,
      parallel_group: "g1"
    },
    {
      task_id: "t2",
      title: "Generate report",
      skill_id: "report.generate",
      tool_id: "artifact.write",
      depends_on: ["t1"],
      estimated_tokens: 3200,
      parallel_group: "g1"
    }
  ]
};

export function sampleJson(): string {
  return JSON.stringify(samplePreflightRequest, null, 2);
}
```

- [ ] **Step 7: Run typecheck to verify the expected current failure**

Run:

```bash
cd frontend
npm install
npm run typecheck
```

Expected: failure because the React entry files do not exist yet.

---

### Task 5: Frontend Client, Hook, and Tests

**Files:**
- Create: `frontend/src/api/preflightClient.ts`
- Create: `frontend/src/hooks/usePreflight.ts`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/pages/AgentRunPreflightPage.test.tsx`

- [ ] **Step 1: Add API client**

Create `frontend/src/api/preflightClient.ts`:

```typescript
import type { PreflightRequest, PreflightResponse } from "../types/preflight";

const endpoint = "/api/v1/platform/runtime/agent-runs/preflight";

export async function runPreflight(request: PreflightRequest): Promise<PreflightResponse> {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Preflight request failed with status ${response.status}`);
  }

  return response.json() as Promise<PreflightResponse>;
}
```

- [ ] **Step 2: Add preflight hook**

Create `frontend/src/hooks/usePreflight.ts`:

```typescript
import { useMemo, useState } from "react";

import { runPreflight } from "../api/preflightClient";
import { sampleJson, samplePreflightRequest } from "../fixtures/samplePreflightRequest";
import type { Environment, PreflightRequest, PreflightResponse } from "../types/preflight";

export type WorkbenchStatus = "empty" | "editing" | "loading" | "result" | "error";

export interface PreflightParams {
  environment: Environment;
  remaining_token_budget: number;
  max_parallel_tasks: number;
}

export function usePreflight() {
  const [jsonText, setJsonText] = useState(sampleJson());
  const [params, setParams] = useState<PreflightParams>({
    environment: samplePreflightRequest.environment,
    remaining_token_budget: samplePreflightRequest.remaining_token_budget,
    max_parallel_tasks: samplePreflightRequest.max_parallel_tasks
  });
  const [status, setStatus] = useState<WorkbenchStatus>("empty");
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isLoading = status === "loading";

  const prettyResult = useMemo(() => {
    return result ? JSON.stringify(result.normalized_plan, null, 2) : "";
  }, [result]);

  function updateJsonText(nextText: string) {
    setJsonText(nextText);
    setStatus("editing");
    setErrorMessage(null);
  }

  function updateParams(nextParams: Partial<PreflightParams>) {
    setParams((current) => ({ ...current, ...nextParams }));
    setStatus("editing");
    setErrorMessage(null);
  }

  function loadSample() {
    setJsonText(sampleJson());
    setParams({
      environment: samplePreflightRequest.environment,
      remaining_token_budget: samplePreflightRequest.remaining_token_budget,
      max_parallel_tasks: samplePreflightRequest.max_parallel_tasks
    });
    setResult(null);
    setErrorMessage(null);
    setStatus("empty");
  }

  function reset() {
    setJsonText("");
    setResult(null);
    setErrorMessage(null);
    setStatus("empty");
  }

  async function validate() {
    let parsed: PreflightRequest;
    try {
      parsed = JSON.parse(jsonText) as PreflightRequest;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      setErrorMessage(`Invalid JSON: ${message}`);
      setStatus("error");
      return;
    }

    const request: PreflightRequest = {
      ...parsed,
      environment: params.environment,
      remaining_token_budget: Number(params.remaining_token_budget),
      max_parallel_tasks: Number(params.max_parallel_tasks)
    };

    setStatus("loading");
    setErrorMessage(null);

    try {
      const response = await runPreflight(request);
      setResult(response);
      setStatus("result");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preflight request failed";
      setErrorMessage(message);
      setStatus("error");
    }
  }

  return {
    jsonText,
    params,
    status,
    result,
    errorMessage,
    isLoading,
    prettyResult,
    updateJsonText,
    updateParams,
    loadSample,
    reset,
    validate
  };
}
```

- [ ] **Step 3: Add test setup**

Create `frontend/src/test/setup.ts`:

```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Add frontend page tests**

Create `frontend/src/pages/AgentRunPreflightPage.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunPreflightPage } from "./AgentRunPreflightPage";
import type { PreflightResponse } from "../types/preflight";

const readyResponse: PreflightResponse = {
  decision: "ready",
  can_execute: true,
  normalized_plan: {
    tasks: [
      {
        task_id: "t1",
        title: "Search source material",
        skill_id: "knowledge.search",
        tool_id: "web.search",
        depends_on: [],
        estimated_tokens: 1800,
        parallel_group: "g1",
        normalization_notes: []
      }
    ]
  },
  budget: {
    estimated_tokens: 1800,
    remaining_after_preflight: 7200,
    budget_status: "ok"
  },
  governance: {
    highest_action_tier: "T1",
    approval_required: false,
    approval_reasons: []
  },
  sandbox: {
    required: false,
    highest_level: "none",
    routes: []
  },
  errors: [],
  warnings: [],
  audit_notes: ["dag_validated", "budget_prechecked", "ready_for_execution"]
};

function mockFetch(response: PreflightResponse, delayMs = 0) {
  const fetchMock = vi.fn(() =>
    new Promise<Response>((resolve) => {
      window.setTimeout(() => {
        resolve(
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }, delayMs);
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentRunPreflightPage", () => {
  it("renders the initial sample request", () => {
    render(<AgentRunPreflightPage />);

    expect(screen.getByRole("heading", { name: /Agent Run Preflight/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Plan JSON/i)).toHaveValue(expect.stringContaining('"thread_id": "thd-001"'));
    expect(screen.getByDisplayValue("prod")).toBeInTheDocument();
  });

  it("does not call the API for invalid JSON", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentRunPreflightPage />);

    await user.clear(screen.getByLabelText(/Plan JSON/i));
    await user.type(screen.getByLabelText(/Plan JSON/i), "{ bad json");
    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/Invalid JSON/i)).toBeInTheDocument();
  });

  it("shows loading state", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse, 50);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(screen.getByRole("button", { name: /Validating/i })).toBeDisabled();
  });

  it("shows ready response", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByText(/Estimated tokens/i)).toBeInTheDocument();
  });

  it("shows blocked errors", async () => {
    const user = userEvent.setup();
    mockFetch({
      ...readyResponse,
      decision: "blocked",
      can_execute: false,
      errors: [
        {
          code: "missing_skill",
          message: "task t1 references missing skill missing.skill",
          field: "tasks[0].skill_id",
          details: {}
        }
      ]
    });
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(await screen.findByText("blocked")).toBeInTheDocument();
    expect(screen.getByText(/missing_skill/i)).toBeInTheDocument();
  });

  it("shows approval reasons", async () => {
    const user = userEvent.setup();
    mockFetch({
      ...readyResponse,
      decision: "requires_approval",
      can_execute: false,
      governance: {
        highest_action_tier: "T3",
        approval_required: true,
        approval_reasons: ["skill report.generate uses action_tier=T3"]
      }
    });
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(await screen.findByText("requires approval")).toBeInTheDocument();
    expect(screen.getByText(/skill report.generate uses action_tier=T3/i)).toBeInTheDocument();
  });

  it("shows normalized plan JSON", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    await waitFor(() => {
      expect(screen.getByText(/Normalized plan/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Search source material/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run frontend tests to verify component failures**

Run:

```bash
cd frontend
npm test
```

Expected: failure because `AgentRunPreflightPage` and display components do not exist yet.

---

### Task 6: Frontend Page Components and Styling

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/styles.css`
- Create: `frontend/src/components/PreflightActions.tsx`
- Create: `frontend/src/components/PreflightIssueList.tsx`
- Create: `frontend/src/components/PreflightJsonEditor.tsx`
- Create: `frontend/src/components/PreflightNormalizedPlan.tsx`
- Create: `frontend/src/components/PreflightParameterPanel.tsx`
- Create: `frontend/src/components/PreflightResultSummary.tsx`
- Create: `frontend/src/pages/AgentRunPreflightPage.tsx`

- [ ] **Step 1: Add React entrypoint**

Create `frontend/src/main.tsx`:

```typescript
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

Create `frontend/src/App.tsx`:

```typescript
import { AgentRunPreflightPage } from "./pages/AgentRunPreflightPage";

export function App() {
  return <AgentRunPreflightPage />;
}
```

- [ ] **Step 2: Add editor component**

Create `frontend/src/components/PreflightJsonEditor.tsx`:

```typescript
interface PreflightJsonEditorProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function PreflightJsonEditor({ value, disabled, onChange }: PreflightJsonEditorProps) {
  return (
    <section className="panel editor-panel">
      <div className="panel-heading">
        <h2>Plan JSON</h2>
      </div>
      <textarea
        aria-label="Plan JSON"
        className="json-editor"
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </section>
  );
}
```

- [ ] **Step 3: Add parameter panel**

Create `frontend/src/components/PreflightParameterPanel.tsx`:

```typescript
import type { Environment } from "../types/preflight";
import type { PreflightParams } from "../hooks/usePreflight";

interface PreflightParameterPanelProps {
  params: PreflightParams;
  disabled: boolean;
  onChange: (params: Partial<PreflightParams>) => void;
}

export function PreflightParameterPanel({ params, disabled, onChange }: PreflightParameterPanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Parameters</h2>
      </div>
      <div className="field-grid">
        <label>
          <span>environment</span>
          <select
            value={params.environment}
            disabled={disabled}
            onChange={(event) => onChange({ environment: event.target.value as Environment })}
          >
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
        </label>
        <label>
          <span>remaining token budget</span>
          <input
            type="number"
            min={0}
            value={params.remaining_token_budget}
            disabled={disabled}
            onChange={(event) => onChange({ remaining_token_budget: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>max parallel tasks</span>
          <input
            type="number"
            min={1}
            value={params.max_parallel_tasks}
            disabled={disabled}
            onChange={(event) => onChange({ max_parallel_tasks: Number(event.target.value) })}
          />
        </label>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add actions component**

Create `frontend/src/components/PreflightActions.tsx`:

```typescript
interface PreflightActionsProps {
  disabled: boolean;
  onLoadSample: () => void;
  onValidate: () => void;
  onReset: () => void;
}

export function PreflightActions({ disabled, onLoadSample, onValidate, onReset }: PreflightActionsProps) {
  return (
    <div className="actions">
      <button type="button" className="secondary" disabled={disabled} onClick={onLoadSample}>
        Load sample
      </button>
      <button type="button" className="primary" disabled={disabled} onClick={onValidate}>
        {disabled ? "Validating" : "Validate"}
      </button>
      <button type="button" className="secondary" disabled={disabled} onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Add issue list component**

Create `frontend/src/components/PreflightIssueList.tsx`:

```typescript
import type { PreflightIssue } from "../types/preflight";

interface PreflightIssueListProps {
  title: string;
  issues: PreflightIssue[];
  emptyText: string;
}

export function PreflightIssueList({ title, issues, emptyText }: PreflightIssueListProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
      </div>
      {issues.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong>
              <span>{issue.message}</span>
              {issue.field ? <small>{issue.field}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Add normalized plan component**

Create `frontend/src/components/PreflightNormalizedPlan.tsx`:

```typescript
interface PreflightNormalizedPlanProps {
  json: string;
}

export function PreflightNormalizedPlan({ json }: PreflightNormalizedPlanProps) {
  return (
    <section className="panel normalized-panel">
      <div className="panel-heading">
        <h2>Normalized plan</h2>
      </div>
      <pre>{json || "No normalized plan yet."}</pre>
    </section>
  );
}
```

- [ ] **Step 7: Add result summary component**

Create `frontend/src/components/PreflightResultSummary.tsx`:

```typescript
import type { Decision, PreflightResponse } from "../types/preflight";

interface PreflightResultSummaryProps {
  result: PreflightResponse | null;
  status: string;
  errorMessage: string | null;
}

function decisionLabel(decision: Decision) {
  return decision === "requires_approval" ? "requires approval" : decision;
}

export function PreflightResultSummary({ result, status, errorMessage }: PreflightResultSummaryProps) {
  if (status === "error") {
    return (
      <section className="panel">
        <div className="status-row">
          <span className="badge blocked">error</span>
          <span>{errorMessage}</span>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="panel">
        <div className="status-row">
          <span className="badge neutral">{status}</span>
          <span className="muted">Run validation to see preflight results.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel summary-grid">
      <div className="status-row full">
        <span className={`badge ${result.decision}`}>{decisionLabel(result.decision)}</span>
        <span>{result.can_execute ? "Can execute directly" : "Execution is not allowed yet"}</span>
      </div>
      <div>
        <h3>Budget summary</h3>
        <dl>
          <dt>Estimated tokens</dt>
          <dd>{result.budget.estimated_tokens}</dd>
          <dt>Remaining after preflight</dt>
          <dd>{result.budget.remaining_after_preflight}</dd>
          <dt>Budget status</dt>
          <dd>{result.budget.budget_status}</dd>
        </dl>
      </div>
      <div>
        <h3>Governance summary</h3>
        <dl>
          <dt>Highest action tier</dt>
          <dd>{result.governance.highest_action_tier}</dd>
          <dt>Approval required</dt>
          <dd>{result.governance.approval_required ? "yes" : "no"}</dd>
        </dl>
        {result.governance.approval_reasons.length > 0 ? (
          <ul className="compact-list">
            {result.governance.approval_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <h3>Sandbox routes</h3>
        <dl>
          <dt>Required</dt>
          <dd>{result.sandbox.required ? "yes" : "no"}</dd>
          <dt>Highest level</dt>
          <dd>{result.sandbox.highest_level}</dd>
        </dl>
        {result.sandbox.routes.length > 0 ? (
          <ul className="compact-list">
            {result.sandbox.routes.map((route) => (
              <li key={`${route.task_id}-${route.sandbox_level}`}>
                {route.task_id}: {route.sandbox_level} - {route.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <h3>Audit notes</h3>
        <ul className="compact-list">
          {result.audit_notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Add page component**

Create `frontend/src/pages/AgentRunPreflightPage.tsx`:

```typescript
import { PreflightActions } from "../components/PreflightActions";
import { PreflightIssueList } from "../components/PreflightIssueList";
import { PreflightJsonEditor } from "../components/PreflightJsonEditor";
import { PreflightNormalizedPlan } from "../components/PreflightNormalizedPlan";
import { PreflightParameterPanel } from "../components/PreflightParameterPanel";
import { PreflightResultSummary } from "../components/PreflightResultSummary";
import { usePreflight } from "../hooks/usePreflight";

export function AgentRunPreflightPage() {
  const workbench = usePreflight();

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <h1>Agent Run Preflight</h1>
          <p>Validate an AgentRun plan before execution.</p>
        </div>
        <span className="path-label">/admin/runtime/agent-run-preflight</span>
      </header>

      <div className="workbench-grid">
        <div className="input-column">
          <PreflightJsonEditor
            value={workbench.jsonText}
            disabled={workbench.isLoading}
            onChange={workbench.updateJsonText}
          />
        </div>
        <div className="side-column">
          <PreflightParameterPanel
            params={workbench.params}
            disabled={workbench.isLoading}
            onChange={workbench.updateParams}
          />
          <PreflightActions
            disabled={workbench.isLoading}
            onLoadSample={workbench.loadSample}
            onValidate={workbench.validate}
            onReset={workbench.reset}
          />
          <PreflightResultSummary
            result={workbench.result}
            status={workbench.status}
            errorMessage={workbench.errorMessage}
          />
        </div>
      </div>

      <div className="results-grid">
        <PreflightIssueList
          title="Errors"
          issues={workbench.result?.errors ?? []}
          emptyText="No blocking errors."
        />
        <PreflightIssueList
          title="Warnings"
          issues={workbench.result?.warnings ?? []}
          emptyText="No warnings."
        />
        <PreflightNormalizedPlan json={workbench.prettyResult} />
      </div>
    </main>
  );
}
```

- [ ] **Step 9: Add styling**

Create `frontend/src/styles.css`:

```css
:root {
  color: #17202a;
  background: #f5f7fb;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

button,
input,
select,
textarea {
  font: inherit;
}

.page-shell {
  width: min(1440px, 100%);
  margin: 0 auto;
  padding: 24px;
}

.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.page-header h1 {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0;
}

.page-header p {
  margin: 6px 0 0;
  color: #5d6d7e;
}

.path-label {
  color: #5d6d7e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

.workbench-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.8fr);
  gap: 16px;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.normalized-panel {
  grid-column: 1 / -1;
}

.panel {
  background: #ffffff;
  border: 1px solid #d7dde8;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(20, 30, 50, 0.04);
}

.panel + .panel,
.actions + .panel {
  margin-top: 16px;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.panel h2,
.panel h3 {
  margin: 0;
  letter-spacing: 0;
}

.panel h2 {
  font-size: 16px;
}

.panel h3 {
  font-size: 14px;
  margin-bottom: 8px;
}

.json-editor {
  width: 100%;
  min-height: 560px;
  resize: vertical;
  border: 1px solid #c8d0dc;
  border-radius: 6px;
  padding: 12px;
  color: #17202a;
  background: #fbfcfe;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.45;
}

.field-grid {
  display: grid;
  gap: 12px;
}

label {
  display: grid;
  gap: 6px;
}

label span,
dt {
  color: #5d6d7e;
  font-size: 12px;
  text-transform: uppercase;
}

input,
select {
  width: 100%;
  border: 1px solid #c8d0dc;
  border-radius: 6px;
  padding: 9px 10px;
  background: #ffffff;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

button {
  min-height: 38px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0 14px;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.primary {
  background: #14532d;
  color: #ffffff;
}

.secondary {
  background: #ffffff;
  color: #17202a;
  border-color: #c8d0dc;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.full {
  grid-column: 1 / -1;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  border-radius: 999px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.ready {
  background: #dcfce7;
  color: #14532d;
}

.requires_approval {
  background: #fef3c7;
  color: #92400e;
}

.blocked {
  background: #fee2e2;
  color: #991b1b;
}

.neutral {
  background: #e8edf5;
  color: #34495e;
}

dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  margin: 0;
}

dd {
  margin: 0;
  font-weight: 600;
}

.muted {
  color: #5d6d7e;
}

.issue-list,
.compact-list {
  margin: 0;
  padding-left: 18px;
}

.issue-list li {
  margin-bottom: 10px;
}

.issue-list strong,
.issue-list span,
.issue-list small {
  display: block;
}

.issue-list small {
  color: #5d6d7e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

pre {
  min-height: 260px;
  max-height: 520px;
  overflow: auto;
  margin: 0;
  border: 1px solid #d7dde8;
  border-radius: 6px;
  padding: 12px;
  background: #fbfcfe;
  font-size: 13px;
  line-height: 1.45;
}

@media (max-width: 960px) {
  .page-shell {
    padding: 16px;
  }

  .page-header,
  .workbench-grid,
  .results-grid,
  .summary-grid {
    grid-template-columns: 1fr;
  }

  .page-header {
    display: grid;
  }

  .json-editor {
    min-height: 420px;
  }
}
```

- [ ] **Step 10: Run frontend tests and typecheck**

Run:

```bash
cd frontend
npm test
npm run typecheck
```

Expected: all frontend tests pass and TypeScript typecheck passes.

---

### Task 7: README and Documentation Sync

**Files:**
- Create: `README.md`
- Modify: `docs/agent-run-preflight-workbench.md`

- [ ] **Step 1: Add root README**

Create `README.md`:

```markdown
# Agent Run Preflight Workbench

Standalone full-stack implementation for the AgentOS Agent Run Preflight Workbench exercise.

## What It Delivers

- Requirements and technical design: `docs/agent-run-preflight-workbench.md`
- FastAPI backend endpoint: `POST /api/v1/platform/runtime/agent-runs/preflight`
- React workbench page: `/admin/runtime/agent-run-preflight`
- Backend tests for required preflight rules
- Frontend tests for page states and result rendering

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check:

```txt
GET http://localhost:8000/health
```

Preflight endpoint:

```txt
POST http://localhost:8000/api/v1/platform/runtime/agent-runs/preflight
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open:

```txt
http://localhost:5173/admin/runtime/agent-run-preflight
```

When the frontend is served separately from the backend, set:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

## Tests

Backend:

```bash
cd backend
python -m pytest
```

Frontend:

```bash
cd frontend
npm test
npm run typecheck
```

## Notes

The implementation uses the request body as the complete preflight plan snapshot. It does not connect to a real Skill Registry, Tool Registry, approval system, sandbox scheduler, or database.
```

- [ ] **Step 2: Sync documentation wording after implementation**

Open `docs/agent-run-preflight-workbench.md` and verify the running commands match the actual files:

```txt
backend/requirements.txt
frontend/package.json
README.md
```

If the implementation used the files and commands above, no document change is needed. If a command changed during execution, update only the command block in section `8. 运行说明`.

- [ ] **Step 3: Run documentation scan**

Run:

```bash
rg -n "TBD|TODO|FIXME|implement later|fill in details" README.md docs/agent-run-preflight-workbench.md
```

Expected: no matches.

---

### Task 8: End-to-End Verification

**Files:**
- No new files.

- [ ] **Step 1: Run backend test suite**

Run:

```bash
cd backend
python -m pytest -q
```

Expected: all backend tests pass.

- [ ] **Step 2: Run frontend test suite**

Run:

```bash
cd frontend
npm test
```

Expected: all frontend tests pass.

- [ ] **Step 3: Run frontend typecheck**

Run:

```bash
cd frontend
npm run typecheck
```

Expected: TypeScript completes with no errors.

- [ ] **Step 4: Start backend locally**

Run:

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

Expected:

```txt
Uvicorn running on http://127.0.0.1:8000
```

- [ ] **Step 5: Start frontend locally**

Run in a second terminal:

```bash
cd frontend
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

Expected:

```txt
Local: http://localhost:5173/
```

- [ ] **Step 6: Manually verify the page**

Open:

```txt
http://localhost:5173/admin/runtime/agent-run-preflight
```

Manual checks:

- The sample JSON is visible.
- Clicking `Validate` returns `requires approval` for the default sample because `artifact.write` uses `exposure_mode=ask`.
- Changing `artifact.write` to `allow` and validating returns `ready`.
- Entering invalid JSON shows a local error and does not call the backend.
- Adding a third task in `parallel_group=g1` with `max_parallel_tasks=2` shows a parallel rewrite warning and normalized dependency.

---

## Self-Review Checklist

- Spec coverage:
  - Requirement analysis is already documented in `docs/agent-run-preflight-workbench.md`.
  - Backend endpoint, schemas, policies, DAG cycle detection, normalized DAG revalidation, budget, governance, sandbox, and decision priority are covered by Tasks 1-3.
  - Frontend page, client, hook, local JSON validation, states, and result display are covered by Tasks 4-6.
  - Backend and frontend tests are covered by Tasks 1, 5, and 8.
  - README and run instructions are covered by Task 7.
- Placeholder scan:
  - Run `rg -n "TBD|TODO|FIXME|implement later|fill in details" docs/superpowers/plans/2026-06-22-agent-run-preflight-workbench.md`.
  - Expected: no matches.
- Type consistency:
  - Backend and frontend both use `requires_approval`, `remaining_after_preflight`, `normalization_notes`, `approval_reasons`, and `sandbox.routes`.
  - Error and warning objects use `code`, `message`, `field`, and `details` on both sides.
