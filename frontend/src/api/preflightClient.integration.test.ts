/**
 * @vitest-environment node
 *
 * Live integration tests against a running backend.
 * Run: VITE_API_BASE_URL=http://localhost:8000 npm run test:integration
 */
import { describe, expect, it } from "vitest";

import { runPreflight } from "./preflightClient";
import { samplePreflightRequest } from "../fixtures/samplePreflightRequest";
import type { PreflightRequest } from "../types/preflight";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function requireLiveBackend(): void {
  if (!apiBase) {
    throw new Error(
      "Set VITE_API_BASE_URL (e.g. http://localhost:8000) to run integration tests"
    );
  }
}

describe("preflightClient integration", () => {
  it("health endpoint is reachable", async () => {
    requireLiveBackend();
    const response = await fetch(`${apiBase}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("allows CORS from the Vite dev origin", async () => {
    requireLiveBackend();
    const response = await fetch(
      `${apiBase}/api/v1/platform/runtime/agent-runs/preflight`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173"
    );
  });

  it("validates the frontend sample request (requires approval)", async () => {
    requireLiveBackend();
    const response = await runPreflight(samplePreflightRequest);

    expect(response.decision).toBe("requires_approval");
    expect(response.can_execute).toBe(false);
    expect(response.budget.estimated_tokens).toBe(5000);
    expect(response.budget.budget_status).toBe("ok");
    expect(response.governance.approval_required).toBe(true);
    expect(response.governance.approval_reasons).toContain(
      "tool artifact.write uses exposure_mode=ask"
    );
    expect(response.errors).toEqual([]);
    expect(response.normalized_plan.tasks).toHaveLength(2);
    expect(response.audit_notes).toContain("dag_validated");
    expect(response.audit_notes).toContain("budget_prechecked");
  });

  it("returns ready for a clean dev plan", async () => {
    requireLiveBackend();
    const request: PreflightRequest = {
      thread_id: "integration-ready",
      environment: "dev",
      remaining_token_budget: 9000,
      max_parallel_tasks: 2,
      skills: [
        {
          skill_id: "knowledge.search",
          status: "active",
          action_tier: "T1",
          sandbox_level: "none"
        }
      ],
      tools: [
        {
          tool_id: "web.search",
          status: "active",
          exposure_mode: "allow"
        }
      ],
      tasks: [
        {
          task_id: "t1",
          title: "Search",
          skill_id: "knowledge.search",
          tool_id: "web.search",
          depends_on: [],
          estimated_tokens: 1000
        }
      ]
    };

    const response = await runPreflight(request);

    expect(response.decision).toBe("ready");
    expect(response.can_execute).toBe(true);
    expect(response.errors).toEqual([]);
    expect(response.normalized_plan.tasks[0].normalization_notes).toEqual([]);
  });

  it("returns blocked for missing skill", async () => {
    requireLiveBackend();
    const request: PreflightRequest = {
      ...samplePreflightRequest,
      tasks: [
        {
          ...samplePreflightRequest.tasks[0],
          skill_id: "missing.skill"
        }
      ]
    };

    const response = await runPreflight(request);

    expect(response.decision).toBe("blocked");
    expect(response.can_execute).toBe(false);
    expect(response.errors.some((item) => item.code === "missing_skill")).toBe(true);
  });

  it("rewrites parallel overflow and returns warning", async () => {
    requireLiveBackend();
    const request: PreflightRequest = {
      thread_id: "integration-parallel",
      environment: "dev",
      remaining_token_budget: 20000,
      max_parallel_tasks: 2,
      skills: [
        {
          skill_id: "knowledge.search",
          status: "active",
          action_tier: "T1",
          sandbox_level: "none"
        }
      ],
      tools: [
        {
          tool_id: "web.search",
          status: "active",
          exposure_mode: "allow"
        }
      ],
      tasks: ["t1", "t2", "t3"].map((task_id) => ({
        task_id,
        title: task_id,
        skill_id: "knowledge.search",
        tool_id: "web.search",
        depends_on: [],
        estimated_tokens: 500,
        parallel_group: "g1"
      }))
    };

    const response = await runPreflight(request);

    expect(response.decision).toBe("ready");
    expect(response.warnings.some((item) => item.code === "parallel_limit_rewritten")).toBe(
      true
    );
    expect(response.audit_notes).toContain("parallel_plan_normalized");

    const t3 = response.normalized_plan.tasks.find((task) => task.task_id === "t3");
    expect(t3?.depends_on).toContain("t2");
    expect(t3?.normalization_notes.length).toBeGreaterThan(0);
  });
});
