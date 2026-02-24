import { mockTools } from '../data/mock-tools';

interface ToolHandlerConfigProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export function ToolHandlerConfig({ enabled, onToggle, disabled }: ToolHandlerConfigProps) {
  return (
    <div className="tool-config">
      <label className="section-label">
        Tool Handler
        <label className="toggle-label">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} disabled={disabled} />
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </label>
      {enabled && (
        <div className="tool-list">
          {mockTools.map((tool) => (
            <div key={tool.name} className="tool-item">
              <code>{tool.name}</code>
              <span className="tool-desc">{tool.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
