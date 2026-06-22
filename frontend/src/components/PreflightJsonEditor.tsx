interface PreflightJsonEditorProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function PreflightJsonEditor({ value, disabled, onChange }: PreflightJsonEditorProps) {
  return (
    <section className="panel editor-panel">
      <div className="panel-heading">
        <h2>Plan JSON</h2>
      </div>
      <textarea
        aria-label="Plan JSON"
        className="json-editor"
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </section>
  );
}
