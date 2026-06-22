import type { PreflightIssue } from "../types/preflight";

interface PreflightIssueListProps {
  title: string;
  issues: PreflightIssue[];
  emptyText: string;
}

export function PreflightIssueList({ title, issues, emptyText }: PreflightIssueListProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
      </div>
      {issues.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong>
              <span>{issue.message}</span>
              {issue.field ? <small>{issue.field}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
