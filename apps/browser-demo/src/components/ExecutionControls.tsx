interface ExecutionControlsProps {
  onRun: () => void;
  running: boolean;
  ready: boolean;
  enclaveLoading: boolean;
  enclaveError: string | null;
}

export function ExecutionControls({ onRun, running, ready, enclaveLoading, enclaveError }: ExecutionControlsProps) {
  const canRun = ready && !running;

  const status = enclaveLoading ? 'loading' : enclaveError ? 'error' : ready ? 'ready' : 'initializing';

  const statusText = enclaveLoading
    ? 'Loading enclave...'
    : enclaveError
      ? `Error: ${enclaveError}`
      : ready
        ? 'Ready'
        : 'Initializing...';

  return (
    <div className="execution-controls">
      <button className="run-btn" onClick={onRun} disabled={!canRun}>
        {running ? 'Running...' : 'Run'}
      </button>
      <span className={`status-indicator status-${status}`}>{statusText}</span>
    </div>
  );
}
