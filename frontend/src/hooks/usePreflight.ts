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
    setResult(null);
    setStatus("editing");
    setErrorMessage(null);
  }

  function updateParams(nextParams: Partial<PreflightParams>) {
    setParams((current) => ({ ...current, ...nextParams }));
    setResult(null);
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
