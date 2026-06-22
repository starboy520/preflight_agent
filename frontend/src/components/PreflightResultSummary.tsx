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
    <section className="panel summary-grid">
      <div className="status-row full">
        <span className={`badge ${result.decision}`}>{decisionLabel(result.decision)}</span>
        <span>{result.can_execute ? "Can execute directly" : "Execution is not allowed yet"}</span>
      </div>
      <div>
        <h3>Budget summary</h3>
        <dl>
          <dt>Estimated tokens</dt>
          <dd>{result.budget.estimated_tokens}</dd>
          <dt>Remaining after preflight</dt>
          <dd>{result.budget.remaining_after_preflight}</dd>
          <dt>Budget status</dt>
          <dd>{result.budget.budget_status}</dd>
        </dl>
      </div>
      <div>
        <h3>Governance summary</h3>
        <dl>
          <dt>Highest action tier</dt>
          <dd>{result.governance.highest_action_tier}</dd>
          <dt>Approval required</dt>
          <dd>{result.governance.approval_required ? "yes" : "no"}</dd>
        </dl>
        {result.governance.approval_reasons.length > 0 ? (
          <ul className="compact-list">
            {result.governance.approval_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <h3>Sandbox routes</h3>
        <dl>
          <dt>Required</dt>
          <dd>{result.sandbox.required ? "yes" : "no"}</dd>
          <dt>Highest level</dt>
          <dd>{result.sandbox.highest_level}</dd>
        </dl>
        {result.sandbox.routes.length > 0 ? (
          <ul className="compact-list">
            {result.sandbox.routes.map((route) => (
              <li key={`${route.task_id}-${route.sandbox_level}`}>
                {route.task_id}: {route.sandbox_level} - {route.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <h3>Audit notes</h3>
        <ul className="compact-list">
          {result.audit_notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
