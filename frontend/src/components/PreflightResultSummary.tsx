import type { Decision, PreflightResponse } from "../types/preflight";

interface PreflightResultSummaryProps {
  result: PreflightResponse | null;
  status: string;
  errorMessage: string | null;
}

function decisionLabel(decision: Decision) {
  return decision === "requires_approval" ? "requires approval" : decision;
}

export function PreflightResultSummary({ result, status, errorMessage }: PreflightResultSummaryProps) {
  if (status === "error") {
    return (
      <section className="panel">
        <div className="status-row">
          <span className="badge blocked">error</span>
          <span>{errorMessage}</span>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="panel">
        <div className="status-row">
          <span className="badge neutral">{status}</span>
          <span className="muted">Run validation to see preflight results.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel result-summary" aria-label="Preflight result summary">
      <div className="result-status">
        <span className={`badge ${result.decision}`}>{decisionLabel(result.decision)}</span>
        <strong>{result.can_execute ? "Can execute directly" : "Execution is not allowed yet"}</strong>
      </div>

      <div className="summary-section summary-metrics" role="group" aria-label="Result metrics">
        <div className="summary-block">
          <h3>Budget summary</h3>
          <dl className="metric-list">
            <dt>Estimated tokens</dt>
            <dd>{result.budget.estimated_tokens}</dd>
            <dt>Remaining after preflight</dt>
            <dd>{result.budget.remaining_after_preflight}</dd>
            <dt>Budget status</dt>
            <dd>{result.budget.budget_status}</dd>
          </dl>
        </div>
        <div className="summary-block">
          <h3>Governance summary</h3>
          <dl className="metric-list">
            <dt>Highest action tier</dt>
            <dd>{result.governance.highest_action_tier}</dd>
            <dt>Approval required</dt>
            <dd>{result.governance.approval_required ? "yes" : "no"}</dd>
          </dl>
        </div>
        <div className="summary-block">
          <h3>Sandbox summary</h3>
          <dl className="metric-list">
            <dt>Required</dt>
            <dd>{result.sandbox.required ? "yes" : "no"}</dd>
            <dt>Highest level</dt>
            <dd>{result.sandbox.highest_level}</dd>
          </dl>
        </div>
      </div>

      <div className="summary-section summary-explanations" role="group" aria-label="Result explanations">
        {result.governance.approval_reasons.length > 0 ? (
          <div className="note-block">
            <h3>Approval reasons</h3>
            <ul className="note-list">
              {result.governance.approval_reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.sandbox.routes.length > 0 ? (
          <div className="note-block">
            <h3>Sandbox routes</h3>
            <ul className="note-list">
              {result.sandbox.routes.map((route) => (
                <li key={`${route.task_id}-${route.sandbox_level}`}>
                  <span className="note-kicker">{route.task_id}</span>
                  <span>
                    {route.sandbox_level}: {route.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="note-block">
          <h3>Audit notes</h3>
          <ul className="note-list note-list-inline">
            {result.audit_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
