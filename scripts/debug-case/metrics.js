#!/usr/bin/env node
/**
 * metrics.js — System-level evolution signal generation
 *
 * Replaces raw tool-usage noise with meaningful system health metrics:
 *   - search_activity: searches performed, case library usage
 *   - fix_validation: fix feedback results (confidence trending)
 *   - promotion_events: cases promoted to Genes
 *   - case_growth: library growth rate
 *   - quality_score: overall data quality index
 *
 * These signals feed into the evolution memory graph for evolver analysis.
 *
 * Usage:
 *   const metrics = require('./metrics');
 *   metrics.record('search_hit', { dc_id, score });
 *   metrics.record('fix_applied', { dc_id, worked });
 *   metrics.snapshot(); // write to memory graph
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const METRICS_PATH = path.join(ROOT, 'memory', 'system_metrics.jsonl');
const HEALTH_PATH = path.join(ROOT, 'memory', 'system_health.json');

// ─── Record a system event ─────────────────────────────────────────────

const EVENT_TYPES = {
  search_hit: { signal: 'system_active', weight: 0.7 },
  search_miss: { signal: 'coverage_gap', weight: 0.5 },
  case_matched: { signal: 'case_reused', weight: 0.8 },
  fix_applied: { signal: 'fix_validated', weight: 0.9 },
  case_added: { signal: 'library_growing', weight: 0.6 },
  case_promoted: { signal: 'evolution_active', weight: 1.0 },
  scraper_run: { signal: 'acquisition_active', weight: 0.5 },
  dedup_blocked: { signal: 'data_quality', weight: 0.4 },
  dev_signal: { signal: 'hook_development_signal', weight: 0.5 },
  client_submission: { signal: 'shared_candidate_submitted', weight: 0.6 },
};

function record(eventType, metadata = {}) {
  const def = EVENT_TYPES[eventType];
  if (!def) return false;

  const entry = {
    timestamp: new Date().toISOString(),
    event_type: eventType,
    signal: def.signal,
    weight: def.weight,
    ...metadata,
  };

  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.appendFileSync(METRICS_PATH, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

// ─── Health snapshot ────────────────────────────────────────────────────

function healthSnapshot(stats) {
  const {
    totalCases = 0,
    searchActivity = 0,
    feedbackSuccess = 0,
    feedbackTotal = 0,
    promotedCount = 0,
    scraperRuns = 0,
  } = stats;

  const feedbackRate = feedbackTotal > 0 ? feedbackSuccess / feedbackTotal : null;
  const librarySize = totalCases >= 30 ? 'healthy' : totalCases >= 15 ? 'adequate' : 'cold_start';
  const evolutionStatus = promotedCount > 0 ? 'active' : 'idle';

  // Quality score: composite index 0-1
  let quality = 0;
  if (totalCases >= 15) quality += 0.3;
  if (totalCases >= 30) quality += 0.1;
  if (feedbackRate !== null && feedbackRate > 0.5) quality += 0.2;
  if (feedbackRate !== null && feedbackRate > 0.8) quality += 0.1;
  if (promotedCount > 0) quality += 0.2;
  if (searchActivity > 0) quality += 0.1;

  const health = {
    timestamp: new Date().toISOString(),
    quality_score: Math.round(quality * 100) / 100,
    library_size: librarySize,
    evolution: evolutionStatus,
    feedback_success_rate: feedbackRate !== null ? Math.round(feedbackRate * 100) + '%' : 'no data',
    metrics: {
      total_cases: totalCases,
      search_activity: searchActivity,
      feedback_total: feedbackTotal,
      feedback_success: feedbackSuccess,
      promoted: promotedCount,
      scraper_runs: scraperRuns,
    },
    recommendations: [],
  };

  if (librarySize === 'cold_start') {
    health.recommendations.push('Run scraper to expand case library beyond 15 cases');
  }
  if (evolutionStatus === 'idle') {
    health.recommendations.push('Cases have matched_count ≥ 3 but none promoted — run promote.js --auto');
  }
  if (feedbackRate !== null && feedbackRate < 0.5) {
    health.recommendations.push('Low fix success rate — review case quality or LLM extraction');
  }
  if (searchActivity === 0) {
    health.recommendations.push('No search activity — team may not be using the dashboard');
  }
  if (health.recommendations.length === 0) {
    health.recommendations.push('System is healthy — continue scraping and team usage');
  }

  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2) + '\n', 'utf8');
  } catch {}

  return health;
}

// ─── Read metrics for analysis ──────────────────────────────────────────

function readMetrics() {
  try {
    if (!fs.existsSync(METRICS_PATH)) return [];
    const raw = fs.readFileSync(METRICS_PATH, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function aggregateMetrics(windowHours = 24) {
  const all = readMetrics();
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const recent = all.filter(e => new Date(e.timestamp).getTime() > cutoff);

  const counts = {};
  for (const e of recent) {
    counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  }

  return {
    window_hours: windowHours,
    total_events: recent.length,
    by_type: counts,
    signals: [...new Set(recent.map(e => e.signal))],
  };
}

module.exports = { record, healthSnapshot, readMetrics, aggregateMetrics, EVENT_TYPES };
