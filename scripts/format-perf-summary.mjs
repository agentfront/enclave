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

/**
 * Escape markdown special characters for table cells
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  if (typeof text !== 'string') return String(text ?? '');
  // Escape backslash FIRST (before other escapes that introduce backslashes)
  // Then escape other markdown special characters for safe table rendering
  return text
    .replace(/\\/g, '\\\\') // Backslash must be escaped first
    .replace(/\|/g, '\\|') // Table cell separator
    .replace(/`/g, '\\`') // Code spans
    .replace(/</g, '&lt;') // HTML tags (use entity to prevent injection)
    .replace(/>/g, '&gt;') // HTML tags
    .replace(/\n/g, ' ') // Newlines break table rows
    .replace(/\r/g, ''); // Carriage returns
}

const resultsFile = process.argv[2] || 'perf-results.json';
const resultsPath = resolve(process.cwd(), resultsFile);

if (!existsSync(resultsPath)) {
  console.log('## Performance Results Not Found\n');
  console.log(`Expected file: \`${resultsFile}\``);
  process.exit(0);
}

let report;
try {
  const content = readFileSync(resultsPath, 'utf-8');
  report = JSON.parse(content);
} catch (error) {
  console.log('## Performance Results Error\n');
  console.log(`Failed to parse \`${resultsFile}\`: ${error.message}`);
  process.exit(1);
}

// Validate required structure
if (!report || typeof report !== 'object') {
  console.log('## Performance Results Error\n');
  console.log('Invalid report format: expected an object');
  process.exit(1);
}

// Header
console.log('## Performance Benchmark Results\n');

// Environment info
const env = report.environment || {};
console.log('### Environment\n');
console.log('| Property | Value |');
console.log('|----------|-------|');
console.log(`| Node | ${env.node || 'N/A'} |`);
console.log(`| Platform | ${env.platform || 'N/A'} |`);
console.log(`| Architecture | ${env.arch || 'N/A'} |`);
console.log(`| CPUs | ${env.cpus || 'N/A'} |`);
console.log(`| Memory | ${env.memory || 'N/A'} |`);
console.log('');

// Test summary
const summary = report.summary || { total: 0, passed: 0, failed: 0, skipped: 0 };
console.log('### Test Summary\n');
const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : '0';
console.log(`**${summary.passed}/${summary.total}** tests passed (${passRate}%)\n`);

if (summary.failed > 0) {
  console.log(`${summary.failed} tests failed\n`);
}

// Key metrics
const metrics = report.metrics || {};
if (Object.keys(metrics).length > 0) {
  console.log('### Key Metrics\n');
  console.log('| Metric | Value | Threshold | Status |');
  console.log('|--------|-------|-----------|--------|');

  const allMetrics = [];
  for (const [testName, testMetrics] of Object.entries(metrics)) {
    if (!Array.isArray(testMetrics)) {
      continue;
    }
    for (const metric of testMetrics) {
      if (metric && typeof metric === 'object') {
        allMetrics.push({ testName, ...metric });
      }
    }
  }

  // Sort by importance (failures first, then by name)
  allMetrics.sort((a, b) => {
    if (a.passed === false && b.passed !== false) return -1;
    if (a.passed !== false && b.passed === false) return 1;
    const nameA = a.name || '';
    const nameB = b.name || '';
    return nameA.localeCompare(nameB);
  });

  for (const metric of allMetrics.slice(0, 30)) {
    const status = metric.passed === false ? 'Failed' : metric.passed === true ? 'Passed' : 'No threshold';
    // Note: Assumes all thresholds are upper bounds (value <= threshold)
    // For lower-bound thresholds (e.g., minimum throughput), set thresholdType = 'min' in the metric
    const thresholdOp = metric.thresholdType === 'min' ? '>=' : '<=';
    const threshold = metric.threshold !== undefined ? `${thresholdOp} ${metric.threshold} ${escapeMarkdown(metric.unit || '')}` : '-';
    const value = typeof metric.value === 'number' ? metric.value.toFixed(2) : escapeMarkdown(String(metric.value || 'N/A'));
    const unit = escapeMarkdown(metric.unit || '');
    const name = escapeMarkdown(metric.name || 'Unknown');
    console.log(`| ${name} | ${value} ${unit} | ${threshold} | ${status} |`);
  }

  if (allMetrics.length > 30) {
    console.log(`\n*... and ${allMetrics.length - 30} more metrics*\n`);
  }
  console.log('');
}

// Detailed results (collapsed)
const results = report.results || [];
if (results.length > 0) {
  console.log('<details>');
  console.log('<summary>Detailed Test Results</summary>\n');
  console.log('| Test | Suite | Status | Duration |');
  console.log('|------|-------|--------|----------|');

  for (const result of results) {
    if (!result || typeof result !== 'object') {
      continue;
    }
    const statusText = escapeMarkdown(result.status || 'unknown');
    const duration = result.duration ? `${result.duration}ms` : '-';
    const testName = escapeMarkdown(result.testName || 'Unknown');
    const suite = escapeMarkdown(result.suite || 'Unknown');
    console.log(`| ${testName} | ${suite} | ${statusText} | ${duration} |`);
  }

  console.log('\n</details>\n');
}

// Footer
const timestamp = report.timestamp || new Date().toISOString();
console.log(`---\n*Generated at ${timestamp}*`);
