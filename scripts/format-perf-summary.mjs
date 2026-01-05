#!/usr/bin/env node
/**
 * Format performance results for GitHub Actions job summary
 *
 * Usage:
 *   node scripts/format-perf-summary.mjs [perf-results.json]
 *
 * Outputs markdown to stdout for use with $GITHUB_STEP_SUMMARY
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const resultsFile = process.argv[2] || 'perf-results.json';
const resultsPath = resolve(process.cwd(), resultsFile);

if (!existsSync(resultsPath)) {
  console.log('## ⚠️ Performance Results Not Found\n');
  console.log(`Expected file: \`${resultsFile}\``);
  process.exit(0);
}

const report = JSON.parse(readFileSync(resultsPath, 'utf-8'));

// Header
console.log('## 📊 Performance Benchmark Results\n');

// Environment info
console.log('### Environment\n');
console.log('| Property | Value |');
console.log('|----------|-------|');
console.log(`| Node | ${report.environment?.node || 'N/A'} |`);
console.log(`| Platform | ${report.environment?.platform || 'N/A'} |`);
console.log(`| Architecture | ${report.environment?.arch || 'N/A'} |`);
console.log(`| CPUs | ${report.environment?.cpus || 'N/A'} |`);
console.log(`| Memory | ${report.environment?.memory || 'N/A'} |`);
console.log('');

// Test summary
console.log('### Test Summary\n');
const { summary } = report;
const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : 0;
console.log(`✅ **${summary.passed}/${summary.total}** tests passed (${passRate}%)\n`);

if (summary.failed > 0) {
  console.log(`❌ ${summary.failed} tests failed\n`);
}

// Key metrics
if (report.metrics && Object.keys(report.metrics).length > 0) {
  console.log('### Key Metrics\n');
  console.log('| Metric | Value | Threshold | Status |');
  console.log('|--------|-------|-----------|--------|');

  const allMetrics = [];
  for (const [testName, metrics] of Object.entries(report.metrics)) {
    for (const metric of metrics) {
      allMetrics.push({ testName, ...metric });
    }
  }

  // Sort by importance (failures first, then by name)
  allMetrics.sort((a, b) => {
    if (a.passed === false && b.passed !== false) return -1;
    if (a.passed !== false && b.passed === false) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const metric of allMetrics.slice(0, 30)) {
    const status =
      metric.passed === false ? '❌ Failed' : metric.passed === true ? '✅ Passed' : '➖ No threshold';
    const threshold = metric.threshold !== undefined ? `≤ ${metric.threshold} ${metric.unit}` : '-';
    const value = typeof metric.value === 'number' ? metric.value.toFixed(2) : metric.value;
    console.log(`| ${metric.name} | ${value} ${metric.unit} | ${threshold} | ${status} |`);
  }

  if (allMetrics.length > 30) {
    console.log(`\n*... and ${allMetrics.length - 30} more metrics*\n`);
  }
  console.log('');
}

// Detailed results (collapsed)
console.log('<details>');
console.log('<summary>📋 Detailed Test Results</summary>\n');
console.log('| Test | Suite | Status | Duration |');
console.log('|------|-------|--------|----------|');

for (const result of report.results || []) {
  const statusEmoji = result.status === 'passed' ? '✅' : result.status === 'failed' ? '❌' : '⏭️';
  const duration = result.duration ? `${result.duration}ms` : '-';
  console.log(`| ${result.testName} | ${result.suite} | ${statusEmoji} ${result.status} | ${duration} |`);
}

console.log('\n</details>\n');

// Footer
console.log(`---\n*Generated at ${report.timestamp}*`);
