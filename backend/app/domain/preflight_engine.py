from collections import defaultdict

from app.domain.policies import (
    duplicate_skill_id_errors,
    duplicate_task_id_errors,
    duplicate_tool_id_errors,
    make_issue,
)
from app.schemas.preflight import (
    BudgetSummary,
    GovernanceSummary,
    NormalizedPlan,
    NormalizedTask,
    PreflightIssue,
    PreflightRequest,
    PreflightResponse,
    SandboxLevel,
    SandboxRoute,
    SandboxSummary,
    SkillRef,
    TaskPlan,
    ToolRef,
)


SANDBOX_ORDER: dict[str, int] = {
    "none": 0,
    "L0": 1,
    "L1": 2,
    "L2": 3,
    "L3": 4,
}
ACTION_TIER_ORDER: dict[str, int] = {"T1": 1, "T2": 2, "T3": 3}


def run_preflight(request: PreflightRequest) -> PreflightResponse:
    skill_index = {skill.skill_id: skill for skill in request.skills}
    tool_index = {tool.tool_id: tool for tool in request.tools}

    errors: list[PreflightIssue] = []
    warnings: list[PreflightIssue] = []
    approval_reasons: list[str] = []
    audit_notes: list[str] = []

    errors.extend(duplicate_skill_id_errors([skill.skill_id for skill in request.skills]))
    errors.extend(duplicate_tool_id_errors([tool.tool_id for tool in request.tools]))
    errors.extend(duplicate_task_id_errors([task.task_id for task in request.tasks]))
    task_index = _unique_task_index(request.tasks)

    registry_result = _validate_registry_refs(request.tasks, skill_index, tool_index)
    errors.extend(registry_result["errors"])
    approval_reasons.extend(registry_result["approval_reasons"])

    dag_errors = _validate_dag(request.tasks, task_index, cycle_code="dag_cycle")
    errors.extend(dag_errors)
    audit_notes.append("dag_validated")

    normalized_plan, normalization_warnings = _normalize_parallel_groups(request)
    warnings.extend(normalization_warnings)
    if normalization_warnings:
        audit_notes.append("parallel_plan_normalized")

    if normalization_warnings and not dag_errors:
        normalized_task_index = _unique_task_index(normalized_plan.tasks)
        normalized_dag_errors = _validate_dag(
            normalized_plan.tasks,
            normalized_task_index,
            cycle_code="normalized_dag_cycle",
            include_unknown_dependencies=False,
        )
        errors.extend(normalized_dag_errors)

    budget = _budget_summary(request)
    if budget.budget_status == "exceeded":
        errors.append(
            make_issue(
                code="budget_exceeded",
                message=(
                    "estimated tokens exceed remaining token budget: "
                    f"{budget.estimated_tokens} > {request.remaining_token_budget}"
                ),
                field="remaining_token_budget",
                details={
                    "estimated_tokens": budget.estimated_tokens,
                    "remaining_token_budget": request.remaining_token_budget,
                    "over_by": budget.estimated_tokens - request.remaining_token_budget,
                },
            )
        )
    audit_notes.append("budget_prechecked")

    sandbox, sandbox_warnings = _sandbox_summary(request, skill_index)
    warnings.extend(sandbox_warnings)
    audit_notes.append("sandbox_route_estimated")

    governance = _governance_summary(request.tasks, skill_index, approval_reasons)
    if governance.approval_required:
        audit_notes.append("approval_required")

    if errors:
        decision = "blocked"
    elif governance.approval_required:
        decision = "requires_approval"
    else:
        decision = "ready"
        audit_notes.append("ready_for_execution")

    return PreflightResponse(
        decision=decision,
        can_execute=decision == "ready",
        normalized_plan=normalized_plan,
        budget=budget,
        governance=governance,
        sandbox=sandbox,
        errors=errors,
        warnings=warnings,
        audit_notes=audit_notes,
    )


def _unique_task_index(tasks: list[TaskPlan]) -> dict[str, TaskPlan]:
    task_index: dict[str, TaskPlan] = {}
    seen: set[str] = set()
    for task in tasks:
        if task.task_id in seen:
            continue
        seen.add(task.task_id)
        task_index[task.task_id] = task
    return task_index


def _validate_registry_refs(
    tasks: list[TaskPlan],
    skill_index: dict[str, SkillRef],
    tool_index: dict[str, ToolRef],
) -> dict[str, list]:
    errors: list[PreflightIssue] = []
    approval_reasons: list[str] = []

    for index, task in enumerate(tasks):
        skill = skill_index.get(task.skill_id)
        if skill is None:
            errors.append(
                make_issue(
                    code="missing_skill",
                    message=f"task {task.task_id} references missing skill {task.skill_id}",
                    field=f"tasks[{index}].skill_id",
                    details={"task_id": task.task_id, "skill_id": task.skill_id},
                )
            )
        else:
            if skill.status != "active":
                errors.append(
                    make_issue(
                        code="inactive_skill",
                        message=f"skill {skill.skill_id} is inactive",
                        field=f"tasks[{index}].skill_id",
                        details={"task_id": task.task_id, "skill_id": skill.skill_id},
                    )
                )
            if skill.action_tier == "T3":
                reason = f"skill {skill.skill_id} uses action_tier=T3"
                if reason not in approval_reasons:
                    approval_reasons.append(reason)

        tool = tool_index.get(task.tool_id)
        if tool is None:
            errors.append(
                make_issue(
                    code="missing_tool",
                    message=f"task {task.task_id} references missing tool {task.tool_id}",
                    field=f"tasks[{index}].tool_id",
                    details={"task_id": task.task_id, "tool_id": task.tool_id},
                )
            )
        else:
            if tool.status != "active":
                errors.append(
                    make_issue(
                        code="inactive_tool",
                        message=f"tool {tool.tool_id} is inactive",
                        field=f"tasks[{index}].tool_id",
                        details={"task_id": task.task_id, "tool_id": tool.tool_id},
                    )
                )
            if tool.exposure_mode == "deny":
                errors.append(
                    make_issue(
                        code="tool_denied",
                        message=f"tool {tool.tool_id} uses exposure_mode=deny",
                        field=f"tasks[{index}].tool_id",
                        details={"task_id": task.task_id, "tool_id": tool.tool_id},
                    )
                )
            if tool.exposure_mode == "ask":
                reason = f"tool {tool.tool_id} uses exposure_mode=ask"
                if reason not in approval_reasons:
                    approval_reasons.append(reason)

    return {"errors": errors, "approval_reasons": approval_reasons}


def _validate_dag(
    tasks: list[TaskPlan],
    task_index: dict[str, TaskPlan],
    cycle_code: str,
    include_unknown_dependencies: bool = True,
) -> list[PreflightIssue]:
    errors: list[PreflightIssue] = []

    if include_unknown_dependencies:
        for index, task in enumerate(tasks):
            for dependency in task.depends_on:
                if dependency not in task_index:
                    errors.append(
                        make_issue(
                            code="unknown_dependency",
                            message=f"task {task.task_id} depends on unknown task {dependency}",
                            field=f"tasks[{index}].depends_on",
                            details={
                                "task_id": task.task_id,
                                "dependency": dependency,
                            },
                        )
                    )

    cycle_path = _find_cycle_path(tasks, task_index)
    if cycle_path:
        errors.append(
            make_issue(
                code=cycle_code,
                message=f"dependency cycle detected: {' -> '.join(cycle_path)}",
                field="tasks.depends_on",
                details={"cycle_path": cycle_path},
            )
        )

    return errors


def _find_cycle_path(tasks: list[TaskPlan], task_index: dict[str, TaskPlan]) -> list[str] | None:
    state: dict[str, str] = {}

    for task in tasks:
        if state.get(task.task_id) == "visited":
            continue

        path: list[str] = []
        path_index: dict[str, int] = {}
        stack: list[tuple[str, int]] = [(task.task_id, 0)]

        while stack:
            task_id, dependency_index = stack[-1]
            current_state = state.get(task_id, "unvisited")

            if current_state == "unvisited":
                state[task_id] = "visiting"
                path_index[task_id] = len(path)
                path.append(task_id)

            current_task = task_index.get(task_id)
            if current_task is None:
                stack.pop()
                path_index.pop(task_id, None)
                if path and path[-1] == task_id:
                    path.pop()
                state[task_id] = "visited"
                continue

            if dependency_index >= len(current_task.depends_on):
                stack.pop()
                path_index.pop(task_id, None)
                if path and path[-1] == task_id:
                    path.pop()
                state[task_id] = "visited"
                continue

            dependency = current_task.depends_on[dependency_index]
            stack[-1] = (task_id, dependency_index + 1)
            if dependency not in task_index:
                continue

            dependency_state = state.get(dependency, "unvisited")
            if dependency_state == "visiting":
                cycle_start = path_index[dependency]
                return path[cycle_start:] + [dependency]
            if dependency_state == "visited":
                continue

            stack.append((dependency, 0))
    return None


def _normalize_parallel_groups(
    request: PreflightRequest,
) -> tuple[NormalizedPlan, list[PreflightIssue]]:
    normalized_tasks = [
        NormalizedTask(**task.model_dump(), normalization_notes=[])
        for task in request.tasks
    ]
    groups: dict[str, list[tuple[int, NormalizedTask]]] = defaultdict(list)
    warnings: list[PreflightIssue] = []

    for index, task in enumerate(normalized_tasks):
        if task.parallel_group:
            groups[task.parallel_group].append((index, task))

    for group_id, grouped_tasks in groups.items():
        if len(grouped_tasks) <= request.max_parallel_tasks:
            continue

        rewritten_task_ids: list[str] = []
        for offset in range(request.max_parallel_tasks, len(grouped_tasks)):
            _task_index, task = grouped_tasks[offset]
            _previous_index, previous_task = grouped_tasks[offset - 1]
            if previous_task.task_id not in task.depends_on:
                task.depends_on.append(previous_task.task_id)
            task.normalization_notes.append(
                f"parallel_group {group_id} exceeds max_parallel_tasks="
                f"{request.max_parallel_tasks}; added dependency on {previous_task.task_id}"
            )
            rewritten_task_ids.append(task.task_id)

        warnings.append(
            make_issue(
                code="parallel_limit_rewritten",
                message=(
                    f"parallel_group {group_id} exceeds max_parallel_tasks="
                    f"{request.max_parallel_tasks}; serialized overflow tasks"
                ),
                field="tasks.parallel_group",
                details={
                    "parallel_group": group_id,
                    "max_parallel_tasks": request.max_parallel_tasks,
                    "rewritten_task_ids": rewritten_task_ids,
                },
            )
        )

    return NormalizedPlan(tasks=normalized_tasks), warnings


def _budget_summary(request: PreflightRequest) -> BudgetSummary:
    estimated_tokens = sum(task.estimated_tokens for task in request.tasks)
    remaining_after_preflight = request.remaining_token_budget - estimated_tokens
    budget_status = "ok" if remaining_after_preflight >= 0 else "exceeded"
    return BudgetSummary(
        estimated_tokens=estimated_tokens,
        remaining_after_preflight=remaining_after_preflight,
        budget_status=budget_status,
    )


def _governance_summary(
    tasks: list[TaskPlan],
    skill_index: dict[str, SkillRef],
    approval_reasons: list[str],
) -> GovernanceSummary:
    referenced_tiers = [
        skill.action_tier
        for task in tasks
        if (skill := skill_index.get(task.skill_id)) is not None
    ]
    highest_action_tier = None
    if referenced_tiers:
        highest_action_tier = max(
            referenced_tiers,
            key=lambda tier: ACTION_TIER_ORDER[tier],
        )

    return GovernanceSummary(
        highest_action_tier=highest_action_tier,
        approval_required=bool(approval_reasons),
        approval_reasons=approval_reasons,
    )


def _sandbox_summary(
    request: PreflightRequest,
    skill_index: dict[str, SkillRef],
) -> tuple[SandboxSummary, list[PreflightIssue]]:
    routes: list[SandboxRoute] = []
    warnings: list[PreflightIssue] = []
    highest_level: SandboxLevel = "none"

    for index, task in enumerate(request.tasks):
        skill = skill_index.get(task.skill_id)
        if skill is None or skill.sandbox_level == "none":
            continue

        sandbox_level = skill.sandbox_level
        reason = f"skill {skill.skill_id} requires sandbox {sandbox_level}"
        if request.environment == "prod" and sandbox_level in {"L0", "L1"}:
            original_level = sandbox_level
            sandbox_level = "L2"
            reason = f"prod environment upgrades {original_level} sandbox to L2"
            warnings.append(
                make_issue(
                    code="prod_sandbox_upgrade",
                    message=(
                        f"task {task.task_id} sandbox level upgraded from "
                        f"{original_level} to L2 in prod"
                    ),
                    field=f"tasks[{index}].skill_id",
                    details={"from": original_level, "to": "L2"},
                )
            )

        routes.append(
            SandboxRoute(
                task_id=task.task_id,
                sandbox_level=sandbox_level,
                reason=reason,
            )
        )
        if SANDBOX_ORDER[sandbox_level] > SANDBOX_ORDER[highest_level]:
            highest_level = sandbox_level

    return (
        SandboxSummary(
            required=bool(routes),
            highest_level=highest_level,
            routes=routes,
        ),
        warnings,
    )
