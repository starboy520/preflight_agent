interface PreflightNormalizedPlanProps {
  json: string;
}

export function PreflightNormalizedPlan({ json }: PreflightNormalizedPlanProps) {
  return (
    <section className="panel normalized-panel">
      <div className="panel-heading">
        <h2>Normalized plan</h2>
      </div>
      <pre>{json || "No normalized plan yet."}</pre>
    </section>
  );
}
