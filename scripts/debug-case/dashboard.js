#!/usr/bin/env node
/**
 * dashboard.js — DebugCase Library Dashboard
 *
 * Generates a human-readable Markdown report of the case library.
 *
 * Usage:
 *   node scripts/debug-case/dashboard.js                          # stdout
 *   node scripts/debug-case/dashboard.js --output report.md       # save to file
 *   node scripts/debug-case/dashboard.js --html                   # HTML format
 *   node scripts/debug-case/dashboard.js --watch                  # auto-refresh
 */

const fs = require('fs');
const path = require('path');
const { loadCases, caseStats } = require('./schema');
const { getEligibleCases } = require('./promote');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'debug_cases', 'candidates');
const GENES_PATH = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep', 'genes.json');
const EVENTS_PATH = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep', 'events.jsonl');

// ─── Data gathering ───────────────────────────────────────────────────────

function gatherData() {
  const cases = loadCases(CASES_PATH);
  const stats = caseStats(cases);

  // Candidate counts
  let candidateCount = 0;
  let latestCandidates = [];
  if (fs.existsSync(CANDIDATES_DIR)) {
    const files = fs.readdirSync(CANDIDATES_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('.'))
      .sort()
      .slice(-3);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(CANDIDATES_DIR, f), 'utf8').trim();
      const lines = raw ? raw.split('\n').filter(Boolean) : [];
      candidateCount += lines.length;
      if (f.startsWith('huawei_raw_')) latestCandidates.push({ file: f, count: lines.length });
    }
  }

  // Gene injection info
  let harmonyGenes = [];
  try {
    const genesData = JSON.parse(fs.readFileSync(GENES_PATH, 'utf8'));
    harmonyGenes = (genesData.genes || []).filter(g => g._source?.kind === 'harmony_debug_case');
  } catch {}

  // Evolution events
  let harmonyEvents = 0;
  try {
    if (fs.existsSync(EVENTS_PATH)) {
      const raw = fs.readFileSync(EVENTS_PATH, 'utf8').trim();
      if (raw) {
        harmonyEvents = raw.split('\n').filter(l =>
          l.includes('harmony_debug_case_promotion') ||
          l.includes('harmony_debug_case_injection')
        ).length;
      }
    }
  } catch {}

  const eligible = getEligibleCases();

  return { cases, stats, candidateCount, latestCandidates, harmonyGenes, harmonyEvents, eligible };
}

// ─── Markdown report ──────────────────────────────────────────────────────

function mdReport(data) {
  const { cases, stats, candidateCount, latestCandidates, harmonyGenes, harmonyEvents, eligible } = data;
  const lines = [];

  lines.push('# HarmonyOS DebugCase Library Report');
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString().slice(0, 19)}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Cases | ${stats.total} |`);
  lines.push(`| Promoted to Genes | ${harmonyGenes.length} |`);
  lines.push(`| Evolution Events | ${harmonyEvents} |`);
  lines.push(`| Raw Candidates (pending) | ${candidateCount} |`);
  lines.push(`| Eligible for Promotion | ${eligible.length} |`);
  lines.push('');

  if (stats.total > 0) {
    lines.push('## By Root Cause Category');
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|----------|-------|');
    for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${cat} | ${count} |`);
    }
    lines.push('');

    lines.push('## By Severity');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    for (const [sev, count] of Object.entries(stats.bySeverity).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${sev} | ${count} |`);
    }
    lines.push('');

    lines.push('## Top API Categories');
    lines.push('');
    lines.push('| API | Count |');
    lines.push('|-----|-------|');
    const sortedApis = Object.entries(stats.byApi).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [api, count] of sortedApis) {
      lines.push(`| ${api} | ${count} |`);
    }
    lines.push('');
  }

  if (eligible.length > 0) {
    lines.push('## Ready for Gene Promotion');
    lines.push('');
    for (const dc of eligible) {
      lines.push(`- **${dc.dc_id}**: ${dc.title} (matched ${dc.evolver_meta?.matched_count}x)`);
    }
    lines.push('');
    lines.push('```bash');
    lines.push('node scripts/debug-case/promote.js --auto');
    lines.push('```');
    lines.push('');
  }

  if (harmonyGenes.length > 0) {
    lines.push('## Injected Genes (in evolver)');
    lines.push('');
    for (const g of harmonyGenes) {
      const src = g._source || {};
      lines.push(`- **${g.id}**: ${g.summary}`);
      lines.push(`  - Source: ${src.source_url || src.source || 'unknown'}`);
      lines.push(`  - Signals: ${(g.signals_match || []).slice(0, 4).join(', ')}`);
    }
    lines.push('');
  }

  if (latestCandidates.length > 0) {
    lines.push('## Recent Raw Data');
    lines.push('');
    for (const f of latestCandidates) {
      lines.push(`- ${f.file}: ${f.count} posts`);
    }
    lines.push('');
    lines.push('```bash');
    lines.push('node scripts/scrapers/llm-extractor.js --file assets/debug_cases/candidates/<file>');
    lines.push('```');
    lines.push('');
  }

  lines.push('## Quick Commands');
  lines.push('');
  lines.push('```bash');
  lines.push('# Search cases');
  lines.push('node scripts/debug-case/search.js --query "权限 闪退"');
  lines.push('node scripts/debug-case/search.js --error-code 907135702');
  lines.push('');
  lines.push('# Promote eligible cases to Genes');
  lines.push('node scripts/debug-case/promote.js --auto');
  lines.push('');
  lines.push('# Run scraper by target count');
  lines.push('node scripts/scrapers/huawei-forum.js --count 100 --concurrency 4');
  lines.push('```');

  return lines.join('\n');
}

// ─── HTML report ──────────────────────────────────────────────────────────

function htmlReport(data) {
  const md = mdReport(data);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>HarmonyOS DebugCase Dashboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
  .card { background: #fff; border-radius: 8px; padding: 20px; margin: 10px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { color: #ff6a00; } /* HarmonyOS orange */
  h2 { color: #333; border-bottom: 2px solid #ff6a00; padding-bottom: 5px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; }
  tr:hover { background: #f0f0f0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
  .badge-critical { background: #ff4444; color: #fff; }
  .badge-major { background: #ff8800; color: #fff; }
  .badge-minor { background: #ffcc00; color: #333; }
  .badge-cosmetic { background: #aaa; color: #fff; }
  code { background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat-item { text-align: center; padding: 15px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .stat-value { font-size: 28px; font-weight: bold; color: #ff6a00; }
  .stat-label { font-size: 13px; color: #666; margin-top: 5px; }
</style>
</head>
<body>
  <h1>HarmonyOS DebugCase Dashboard</h1>
  <p>Generated: ${new Date().toISOString().slice(0, 19)}</p>

  <div class="stat-grid">
    <div class="stat-item">
      <div class="stat-value">${data.stats.total}</div>
      <div class="stat-label">Total Cases</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.harmonyGenes.length}</div>
      <div class="stat-label">Genes Injected</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.candidateCount}</div>
      <div class="stat-label">Raw Candidates</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.eligible.length}</div>
      <div class="stat-label">Eligible for Promotion</div>
    </div>
  </div>

  <div class="card">
    <h2>Cases by Severity</h2>
    <table>
      <tr><th>Severity</th><th>Count</th></tr>
      ${Object.entries(data.stats.bySeverity).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<tr><td><span class="badge badge-${k}">${k}</span></td><td>${v}</td></tr>`
      ).join('')}
    </table>
  </div>

  <div class="card">
    <h2>Top API Categories</h2>
    <table>
      <tr><th>API</th><th>Count</th></tr>
      ${Object.entries(data.stats.byApi).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) =>
        `<tr><td>${k || '(uncategorized)'}</td><td>${v}</td></tr>`
      ).join('')}
    </table>
  </div>

  <div class="card">
    <h2>Commands</h2>
    <p><code>node scripts/debug-case/search.js --query "权限 闪退"</code></p>
    <p><code>node scripts/debug-case/search.js --error-code 907135702</code></p>
    <p><code>node scripts/debug-case/promote.js --auto</code></p>
    <p><code>node scripts/scrapers/huawei-forum.js --count 100 --concurrency 4</code></p>
  </div>
</body>
</html>`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const data = gatherData();

  const htmlFlag = args.includes('--html');
  const outputIdx = args.indexOf('--output');

  let report;
  if (htmlFlag) {
    report = htmlReport(data);
  } else {
    report = mdReport(data);
  }

  if (outputIdx >= 0 && outputIdx + 1 < args.length) {
    fs.writeFileSync(args[outputIdx + 1], report, 'utf8');
    console.log(`Report saved to: ${args[outputIdx + 1]}`);
  } else {
    console.log(report);
  }
}

if (require.main === module) main();

module.exports = { mdReport, htmlReport, gatherData };
