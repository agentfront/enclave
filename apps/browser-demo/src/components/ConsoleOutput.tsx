import type { ConsoleEntry } from '../types';

interface ConsoleOutputProps {
  entries: ConsoleEntry[];
}

const LEVEL_CLASS: Record<string, string> = {
  log: 'console-log',
  info: 'console-info',
  warn: 'console-warn',
  error: 'console-error',
};

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

export function ConsoleOutput({ entries }: ConsoleOutputProps) {
  return (
    <div className="console-output">
      <label className="section-label">Console ({entries.length})</label>
      <div className="console-entries">
        {entries.length === 0 && <div className="console-empty">No console output</div>}
        {entries.map((entry) => (
          <div key={entry.id} className={`console-entry ${LEVEL_CLASS[entry.level] ?? ''}`}>
            <span className="console-level">[{entry.level.toUpperCase()}]</span>
            <span className="console-msg">{entry.args.map(formatArg).join(' ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
