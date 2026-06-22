import type { Environment, PreflightRequest } from "../types/preflight";

export interface SamplePreflightOptions {
  environment?: Environment;
  remaining_token_budget?: number;
  max_parallel_tasks?: number;
}

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

export function sampleJson(options: SamplePreflightOptions = {}): string {
  return JSON.stringify(
    {
      ...samplePreflightRequest,
      ...options
    },
    null,
    2
  );
}
