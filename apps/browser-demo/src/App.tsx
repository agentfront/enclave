import { useState, useCallback, useMemo } from 'react';
import { useEnclave } from './hooks/use-enclave';
import { useConsoleCapture } from './hooks/use-console-capture';
import { createToolHandler, mockTools } from './data/mock-tools';
import { CodeEditor } from './components/CodeEditor';
import { SecurityLevelPicker } from './components/SecurityLevelPicker';
import { ExampleSnippets } from './components/ExampleSnippets';
import { ToolHandlerConfig } from './components/ToolHandlerConfig';
import { ExecutionControls } from './components/ExecutionControls';
import { ConsoleOutput } from './components/ConsoleOutput';
import { ResultDisplay } from './components/ResultDisplay';
import { StatsPanel } from './components/StatsPanel';
import type { SecurityLevel, ConsoleEntry, ExecutionStats, DemoExecutionResult } from './types';

export function App() {
  const [code, setCode] = useState('return 2 + 2;');
  const [securityLevel, setSecurityLevel] = useState<SecurityLevel>('STANDARD');
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DemoExecutionResult | null>(null);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [stats, setStats] = useState<ExecutionStats | null>(null);

  const toolHandler = useMemo(() => (toolsEnabled ? createToolHandler(mockTools) : undefined), [toolsEnabled]);

  const {
    ready,
    loading: enclaveLoading,
    error: enclaveError,
    run,
  } = useEnclave({
    securityLevel,
    toolHandler,
  });

  const { startCapture, stopCapture } = useConsoleCapture();

  const handleRun = useCallback(async () => {
    if (!ready || running) return;
    setRunning(true);
    setResult(null);
    setConsoleEntries([]);
    setStats(null);

    try {
      startCapture();
      const execResult = await run(code);
      setResult(execResult);
      if (execResult.stats) {
        setStats({
          duration: execResult.stats.duration,
          toolCallCount: execResult.stats.toolCallCount,
          iterationCount: execResult.stats.iterationCount,
        });
      }
    } catch (err) {
      const zeroStats = { duration: 0, toolCallCount: 0, iterationCount: 0 };
      setResult({
        success: false,
        error: {
          name: 'AppError',
          message: err instanceof Error ? err.message : String(err),
        },
        stats: zeroStats,
      });
      setStats(zeroStats);
    } finally {
      const captured = stopCapture();
      setConsoleEntries(captured);
      setRunning(false);
    }
  }, [ready, running, code, run, startCapture, stopCapture]);

  const handleExampleSelect = useCallback((exampleCode: string) => {
    setCode(exampleCode);
    setResult(null);
    setConsoleEntries([]);
    setStats(null);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>@enclave-vm/browser Demo</h1>
        <p className="app-subtitle">Sandboxed JavaScript execution using double iframe isolation</p>
      </header>

      <main className="app-main">
        <div className="left-panel">
          <SecurityLevelPicker value={securityLevel} onChange={setSecurityLevel} disabled={running} />
          <ToolHandlerConfig enabled={toolsEnabled} onToggle={setToolsEnabled} disabled={running} />
          <ExampleSnippets onSelect={handleExampleSelect} disabled={running} />
        </div>

        <div className="center-panel">
          <CodeEditor value={code} onChange={setCode} disabled={running} />
          <ExecutionControls
            onRun={handleRun}
            running={running}
            ready={ready}
            enclaveLoading={enclaveLoading}
            enclaveError={enclaveError}
          />
        </div>

        <div className="right-panel">
          <ResultDisplay result={result} />
          <ConsoleOutput entries={consoleEntries} />
          <StatsPanel stats={stats} />
        </div>
      </main>
    </div>
  );
}
