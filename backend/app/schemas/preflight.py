from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints


Environment = Literal["dev", "staging", "prod"]
SkillStatus = Literal["active", "inactive"]
ToolStatus = Literal["active", "inactive"]
ActionTier = Literal["T1", "T2", "T3"]
SandboxLevel = Literal["none", "L0", "L1", "L2", "L3"]
ExposureMode = Literal["allow", "ask", "deny"]
Decision = Literal["blocked", "requires_approval", "ready"]
BudgetStatus = Literal["ok", "exceeded"]
NonBlankString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class SkillRef(BaseModel):
    skill_id: NonBlankString
    status: SkillStatus
    action_tier: ActionTier
    sandbox_level: SandboxLevel


class ToolRef(BaseModel):
    tool_id: NonBlankString
    status: ToolStatus
    exposure_mode: ExposureMode


class TaskPlan(BaseModel):
    task_id: NonBlankString
    title: NonBlankString
    skill_id: NonBlankString
    tool_id: NonBlankString
    depends_on: list[NonBlankString] = Field(default_factory=list)
    estimated_tokens: int = Field(ge=0)
    parallel_group: NonBlankString | None = None


class PreflightRequest(BaseModel):
    thread_id: NonBlankString
    environment: Environment
    remaining_token_budget: int = Field(ge=0)
    max_parallel_tasks: int = Field(ge=1)
    skills: list[SkillRef]
    tools: list[ToolRef]
    tasks: list[TaskPlan] = Field(min_length=1)


class NormalizedTask(TaskPlan):
    normalization_notes: list[str] = Field(default_factory=list)


class NormalizedPlan(BaseModel):
    tasks: list[NormalizedTask]


class BudgetSummary(BaseModel):
    estimated_tokens: int
    remaining_after_preflight: int
    budget_status: BudgetStatus


class GovernanceSummary(BaseModel):
    highest_action_tier: ActionTier | None = None
    approval_required: bool
    approval_reasons: list[str]


class SandboxRoute(BaseModel):
    task_id: str
    sandbox_level: SandboxLevel
    reason: str


class SandboxSummary(BaseModel):
    required: bool
    highest_level: SandboxLevel
    routes: list[SandboxRoute]


class PreflightIssue(BaseModel):
    code: str
    message: str
    field: str
    details: dict = Field(default_factory=dict)


class PreflightResponse(BaseModel):
    decision: Decision
    can_execute: bool
    normalized_plan: NormalizedPlan
    budget: BudgetSummary
    governance: GovernanceSummary
    sandbox: SandboxSummary
    errors: list[PreflightIssue]
    warnings: list[PreflightIssue]
    audit_notes: list[str]
