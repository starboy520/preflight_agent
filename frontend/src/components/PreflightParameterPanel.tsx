import type { PreflightParams } from "../hooks/usePreflight";
import type { Environment } from "../types/preflight";

interface PreflightParameterPanelProps {
  params: PreflightParams;
  disabled: boolean;
  onChange: (params: Partial<PreflightParams>) => void;
}

export function PreflightParameterPanel({ params, disabled, onChange }: PreflightParameterPanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Sample preset</h2>
      </div>
      <div className="field-grid">
        <label>
          <span>environment</span>
          <select
            aria-label="environment"
            value={params.environment}
            disabled={disabled}
            onChange={(event) => onChange({ environment: event.target.value as Environment })}
          >
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
        </label>
        <label>
          <span>remaining token budget</span>
          <input
            aria-label="remaining token budget"
            type="number"
            min={0}
            value={params.remaining_token_budget}
            disabled={disabled}
            onChange={(event) => onChange({ remaining_token_budget: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>max parallel tasks</span>
          <input
            aria-label="max parallel tasks"
            type="number"
            min={1}
            value={params.max_parallel_tasks}
            disabled={disabled}
            onChange={(event) => onChange({ max_parallel_tasks: Number(event.target.value) })}
          />
        </label>
      </div>
    </section>
  );
}
