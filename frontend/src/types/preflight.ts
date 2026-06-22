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
