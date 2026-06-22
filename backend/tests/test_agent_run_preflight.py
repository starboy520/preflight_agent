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


def test_health_check():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_preflight_allows_frontend_dev_origin():
    response = client.options(
        "/api/v1/platform/runtime/agent-runs/preflight",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "POST" in response.headers["access-control-allow-methods"]


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
    assert "ready_for_execution" in body["audit_notes"]


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


def test_inactive_t3_skill_blocks_and_keeps_approval_reason():
    payload = request_copy()
    payload["skills"][1]["status"] = "inactive"
    payload["skills"][1]["action_tier"] = "T3"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "inactive_skill" in issue_codes(body)
    assert "skill report.generate uses action_tier=T3" in body["governance"]["approval_reasons"]


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


def test_inactive_ask_tool_blocks_and_keeps_approval_reason():
    payload = request_copy()
    payload["tools"][1]["status"] = "inactive"
    payload["tools"][1]["exposure_mode"] = "ask"

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "inactive_tool" in issue_codes(body)
    assert "tool artifact.write uses exposure_mode=ask" in body["governance"]["approval_reasons"]


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
    assert "normalized_dag_cycle" not in issue_codes(body)


def test_original_cycle_does_not_double_report_as_normalized_cycle_after_rewrite():
    payload = request_copy()
    payload["tasks"][0]["depends_on"] = ["t2"]
    payload["tasks"][1]["depends_on"] = ["t1"]
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

    assert body["decision"] == "blocked"
    assert "parallel_limit_rewritten" in issue_codes(body, "warnings")
    assert "dag_cycle" in issue_codes(body)
    assert "normalized_dag_cycle" not in issue_codes(body)


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


def test_duplicate_skill_id_blocks_even_when_referenced():
    payload = request_copy()
    payload["skills"].append(
        {
            "skill_id": "knowledge.search",
            "status": "active",
            "action_tier": "T1",
            "sandbox_level": "none",
        }
    )

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "duplicate_skill_id" in issue_codes(body)


def test_duplicate_tool_id_blocks_even_when_referenced():
    payload = request_copy()
    payload["tools"].append(
        {
            "tool_id": "web.search",
            "status": "active",
            "exposure_mode": "allow",
        }
    )

    body = post_preflight(payload).json()

    assert body["decision"] == "blocked"
    assert "duplicate_tool_id" in issue_codes(body)


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


def test_invalid_environment_returns_422():
    payload = request_copy()
    payload["environment"] = "qa"

    response = post_preflight(payload)

    assert response.status_code == 422


def test_negative_remaining_token_budget_returns_422():
    payload = request_copy()
    payload["remaining_token_budget"] = -1

    response = post_preflight(payload)

    assert response.status_code == 422


def test_max_parallel_tasks_less_than_one_returns_422():
    payload = request_copy()
    payload["max_parallel_tasks"] = 0

    response = post_preflight(payload)

    assert response.status_code == 422


def test_negative_estimated_tokens_returns_422():
    payload = request_copy()
    payload["tasks"][0]["estimated_tokens"] = -1

    response = post_preflight(payload)

    assert response.status_code == 422


def test_empty_tasks_returns_422():
    payload = request_copy()
    payload["tasks"] = []

    response = post_preflight(payload)

    assert response.status_code == 422


def test_whitespace_thread_id_returns_422():
    payload = request_copy()
    payload["thread_id"] = "   "

    response = post_preflight(payload)

    assert response.status_code == 422


def test_whitespace_skill_id_returns_422():
    payload = request_copy()
    payload["skills"][0]["skill_id"] = "   "

    response = post_preflight(payload)

    assert response.status_code == 422


def test_whitespace_tool_id_returns_422():
    payload = request_copy()
    payload["tools"][0]["tool_id"] = "   "

    response = post_preflight(payload)

    assert response.status_code == 422


def test_whitespace_task_id_returns_422():
    payload = request_copy()
    payload["tasks"][0]["task_id"] = "   "

    response = post_preflight(payload)

    assert response.status_code == 422


def test_whitespace_dependency_id_returns_422():
    payload = request_copy()
    payload["tasks"][1]["depends_on"] = ["   "]

    response = post_preflight(payload)

    assert response.status_code == 422


def test_long_valid_dependency_chain_avoids_recursion_limit():
    payload = request_copy()
    payload["remaining_token_budget"] = 2000
    payload["max_parallel_tasks"] = 1200
    payload["tasks"] = [
        {
            "task_id": f"t{index}",
            "title": f"Task {index}",
            "skill_id": "knowledge.search",
            "tool_id": "web.search",
            "depends_on": [f"t{index + 1}"] if index < 1199 else [],
            "estimated_tokens": 1,
            "parallel_group": None,
        }
        for index in range(1200)
    ]

    response = post_preflight(payload)

    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "ready"
    assert body["errors"] == []
