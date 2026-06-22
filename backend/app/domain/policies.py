from collections import Counter
from dataclasses import dataclass, field

from app.schemas.preflight import PreflightIssue


@dataclass
class PolicyResult:
    errors: list[PreflightIssue] = field(default_factory=list)
    warnings: list[PreflightIssue] = field(default_factory=list)
    approval_reasons: list[str] = field(default_factory=list)
    audit_notes: list[str] = field(default_factory=list)


def make_issue(
    code: str,
    message: str,
    field: str,
    details: dict | None = None,
) -> PreflightIssue:
    return PreflightIssue(
        code=code,
        message=message,
        field=field,
        details=details or {},
    )


def duplicate_task_id_errors(task_ids: list[str]) -> list[PreflightIssue]:
    counts = Counter(task_ids)
    return [
        make_issue(
            code="duplicate_task_id",
            message=f"duplicate task_id detected: {task_id}",
            field="tasks.task_id",
            details={"task_id": task_id},
        )
        for task_id, count in counts.items()
        if count > 1
    ]


def duplicate_skill_id_errors(skill_ids: list[str]) -> list[PreflightIssue]:
    counts = Counter(skill_ids)
    return [
        make_issue(
            code="duplicate_skill_id",
            message=f"duplicate skill_id detected: {skill_id}",
            field="skills.skill_id",
            details={"skill_id": skill_id},
        )
        for skill_id, count in counts.items()
        if count > 1
    ]


def duplicate_tool_id_errors(tool_ids: list[str]) -> list[PreflightIssue]:
    counts = Counter(tool_ids)
    return [
        make_issue(
            code="duplicate_tool_id",
            message=f"duplicate tool_id detected: {tool_id}",
            field="tools.tool_id",
            details={"tool_id": tool_id},
        )
        for tool_id, count in counts.items()
        if count > 1
    ]
