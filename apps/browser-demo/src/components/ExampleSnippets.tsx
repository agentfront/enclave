import { examples } from '../data/examples';

interface ExampleSnippetsProps {
  onSelect: (code: string) => void;
  disabled?: boolean;
}

const CATEGORIES = ['Basic', 'Async', 'Tools', 'Security'] as const;

export function ExampleSnippets({ onSelect, disabled }: ExampleSnippetsProps) {
  return (
    <div className="examples">
      <label className="section-label">Examples</label>
      {CATEGORIES.map((category) => {
        const items = examples.filter((e) => e.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category} className="example-group">
            <span className="example-category">{category}</span>
            {items.map((ex) => (
              <button
                key={ex.label}
                className="example-btn"
                onClick={() => onSelect(ex.code)}
                disabled={disabled}
                title={ex.description}
              >
                {ex.label}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
