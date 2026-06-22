import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect((screen.getByLabelText(/Plan JSON/i) as HTMLTextAreaElement).value).toContain('"thread_id": "thd-001"');
    expect(screen.getByDisplayValue("prod")).toBeInTheDocument();
  });

  it("does not call the API for invalid JSON", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentRunPreflightPage />);

    fireEvent.change(screen.getByLabelText(/Plan JSON/i), { target: { value: "{ bad json" } });
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

  it("validates the editor JSON without applying sample preset controls", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.selectOptions(screen.getByLabelText(/environment/i), "staging");
    await user.clear(screen.getByLabelText(/remaining token budget/i));
    await user.type(screen.getByLabelText(/remaining token budget/i), "4500");
    await user.clear(screen.getByLabelText(/max parallel tasks/i));
    await user.type(screen.getByLabelText(/max parallel tasks/i), "1");
    await user.click(screen.getByRole("button", { name: /Validate/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const request = JSON.parse(init.body as string);
    expect(request).toMatchObject({
      environment: "prod",
      remaining_token_budget: 9000,
      max_parallel_tasks: 2
    });
  });

  it("uses sample preset controls when loading a sample request", async () => {
    const user = userEvent.setup();
    render(<AgentRunPreflightPage />);

    await user.selectOptions(screen.getByLabelText(/environment/i), "staging");
    await user.clear(screen.getByLabelText(/remaining token budget/i));
    await user.type(screen.getByLabelText(/remaining token budget/i), "4500");
    await user.clear(screen.getByLabelText(/max parallel tasks/i));
    await user.type(screen.getByLabelText(/max parallel tasks/i), "1");
    await user.click(screen.getByRole("button", { name: /Load sample/i }));

    const request = JSON.parse((screen.getByLabelText(/Plan JSON/i) as HTMLTextAreaElement).value);
    expect(request).toMatchObject({
      environment: "staging",
      remaining_token_budget: 4500,
      max_parallel_tasks: 1
    });
  });

  it("shows ready response", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByText(/Estimated tokens/i)).toBeInTheDocument();
  });

  it("clears the previous result when request inputs change", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    expect(await screen.findByText("ready")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/environment/i), "staging");

    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated tokens/i)).not.toBeInTheDocument();
    expect(screen.getByText("editing")).toBeInTheDocument();
    expect(screen.getByText(/Run validation to see preflight results/i)).toBeInTheDocument();
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

  it("separates result metrics from long explanatory notes", async () => {
    const user = userEvent.setup();
    mockFetch({
      ...readyResponse,
      decision: "requires_approval",
      can_execute: false,
      governance: {
        highest_action_tier: "T2",
        approval_required: true,
        approval_reasons: ["tool artifact.write uses exposure_mode=ask"]
      },
      sandbox: {
        required: true,
        highest_level: "L2",
        routes: [
          {
            task_id: "t2",
            sandbox_level: "L2",
            reason: "prod environment upgrades L1 sandbox to L2"
          }
        ]
      },
      audit_notes: ["dag_validated", "budget_prechecked", "sandbox_route_estimated", "approval_required"]
    });
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    const summary = await screen.findByRole("region", { name: /preflight result summary/i });
    const metrics = within(summary).getByRole("group", { name: /result metrics/i });
    const explanations = within(summary).getByRole("group", { name: /result explanations/i });

    expect(within(metrics).getByText(/Estimated tokens/i)).toBeInTheDocument();
    expect(within(metrics).getByText(/Highest action tier/i)).toBeInTheDocument();
    expect(within(explanations).getByText(/tool artifact.write uses exposure_mode=ask/i)).toBeInTheDocument();
    expect(within(explanations).getByText(/t2/i)).toBeInTheDocument();
    expect(within(explanations).getByText(/sandbox_route_estimated/i)).toBeInTheDocument();
  });

  it("shows normalized plan JSON", async () => {
    const user = userEvent.setup();
    mockFetch(readyResponse);
    render(<AgentRunPreflightPage />);

    await user.click(screen.getByRole("button", { name: /Validate/i }));

    const normalizedPlanHeading = await screen.findByText(/Normalized plan/i);
    const normalizedPlanPanel = normalizedPlanHeading.closest("section");

    expect(normalizedPlanPanel).not.toBeNull();
    expect(within(normalizedPlanPanel as HTMLElement).getByText(/Search source material/i)).toBeInTheDocument();
  });
});
