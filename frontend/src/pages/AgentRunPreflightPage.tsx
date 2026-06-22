import { PreflightActions } from "../components/PreflightActions";
import { PreflightIssueList } from "../components/PreflightIssueList";
import { PreflightJsonEditor } from "../components/PreflightJsonEditor";
import { PreflightNormalizedPlan } from "../components/PreflightNormalizedPlan";
import { PreflightParameterPanel } from "../components/PreflightParameterPanel";
import { PreflightResultSummary } from "../components/PreflightResultSummary";
import { usePreflight } from "../hooks/usePreflight";

export function AgentRunPreflightPage() {
  const workbench = usePreflight();

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <h1>Agent Run Preflight</h1>
          <p>Validate an AgentRun plan before execution.</p>
        </div>
        <span className="path-label">/admin/runtime/agent-run-preflight</span>
      </header>

      <div className="workbench-grid">
        <div className="input-column">
          <PreflightJsonEditor
            value={workbench.jsonText}
            disabled={workbench.isLoading}
            onChange={workbench.updateJsonText}
          />
        </div>
        <div className="side-column">
          <PreflightParameterPanel
            params={workbench.params}
            disabled={workbench.isLoading}
            onChange={workbench.updateParams}
          />
          <PreflightActions
            disabled={workbench.isLoading}
            onLoadSample={workbench.loadSample}
            onValidate={workbench.validate}
            onReset={workbench.reset}
          />
          <PreflightResultSummary
            result={workbench.result}
            status={workbench.status}
            errorMessage={workbench.errorMessage}
          />
        </div>
      </div>

      <div className="results-grid">
        <PreflightIssueList
          title="Errors"
          issues={workbench.result?.errors ?? []}
          emptyText="No blocking errors."
        />
        <PreflightIssueList
          title="Warnings"
          issues={workbench.result?.warnings ?? []}
          emptyText="No warnings."
        />
        <PreflightNormalizedPlan json={workbench.prettyResult} />
      </div>
    </main>
  );
}
