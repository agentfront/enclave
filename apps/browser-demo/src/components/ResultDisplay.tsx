interface ResultDisplayProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any | null;
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ResultDisplay({ result }: ResultDisplayProps) {
  if (!result) {
    return (
      <div className="result-display">
        <label className="section-label">Result</label>
        <div className="result-empty">Run code to see results</div>
      </div>
    );
  }

  const isError = !result.success;

  return (
    <div className="result-display">
      <label className="section-label">Result</label>
      <div className={`result-content ${isError ? 'result-error' : 'result-success'}`}>
        {isError ? (
          <>
            <div className="result-error-name">{result.error?.name ?? 'Error'}</div>
            <pre className="result-pre">{result.error?.message ?? 'Unknown error'}</pre>
          </>
        ) : (
          <pre className="result-pre">{formatValue(result.value)}</pre>
        )}
      </div>
    </div>
  );
}
