import type { ExecutionStats } from '../types';

interface StatsPanelProps {
  stats: ExecutionStats | null;
}

export function StatsPanel({ stats }: StatsPanelProps) {
  return (
    <div className="stats-panel">
      <label className="section-label">Stats</label>
      {!stats ? (
        <div className="stats-empty">No execution stats yet</div>
      ) : (
        <div className="stats-grid">
          <div className="stat-item">
            <span className="stat-label">Duration</span>
            <span className="stat-value">{stats.duration}ms</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Tool Calls</span>
            <span className="stat-value">{stats.toolCallCount}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Iterations</span>
            <span className="stat-value">{stats.iterationCount}</span>
          </div>
        </div>
      )}
    </div>
  );
}
