interface PreflightActionsProps {
  disabled: boolean;
  onLoadSample: () => void;
  onValidate: () => void;
  onReset: () => void;
}

export function PreflightActions({ disabled, onLoadSample, onValidate, onReset }: PreflightActionsProps) {
  return (
    <div className="actions">
      <button type="button" className="secondary" disabled={disabled} onClick={onLoadSample}>
        Load sample
      </button>
      <button type="button" className="primary" disabled={disabled} onClick={onValidate}>
        {disabled ? "Validating" : "Validate"}
      </button>
      <button type="button" className="secondary" disabled={disabled} onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
