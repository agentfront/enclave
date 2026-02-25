import type { SecurityLevel } from '../types';

const LEVELS: SecurityLevel[] = ['STRICT', 'SECURE', 'STANDARD', 'PERMISSIVE'];

const DESCRIPTIONS: Record<SecurityLevel, string> = {
  STRICT: 'Max restrictions, 1K iterations, 5s timeout',
  SECURE: 'Balanced security, 5K iterations, 15s timeout',
  STANDARD: 'Default, 10K iterations, unbounded loops',
  PERMISSIVE: 'Minimal restrictions, 100K iterations',
};

interface SecurityLevelPickerProps {
  value: SecurityLevel;
  onChange: (level: SecurityLevel) => void;
  disabled?: boolean;
}

export function SecurityLevelPicker({ value, onChange, disabled }: SecurityLevelPickerProps) {
  return (
    <div className="security-picker">
      <label className="section-label">Security Level</label>
      <div className="segmented-buttons">
        {LEVELS.map((level) => (
          <button
            key={level}
            className={`seg-btn ${value === level ? 'active' : ''}`}
            onClick={() => onChange(level)}
            disabled={disabled}
            title={DESCRIPTIONS[level]}
          >
            {level}
          </button>
        ))}
      </div>
      <span className="security-desc">{DESCRIPTIONS[value]}</span>
    </div>
  );
}
