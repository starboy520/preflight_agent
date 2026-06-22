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
