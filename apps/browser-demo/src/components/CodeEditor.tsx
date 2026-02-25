interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function CodeEditor({ value, onChange, disabled }: CodeEditorProps) {
  return (
    <div className="code-editor">
      <label className="section-label">Code</label>
      <textarea
        className="code-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        placeholder="Enter AgentScript code..."
      />
    </div>
  );
}
