#!/usr/bin/env node
/**
 * schema.js — DebugCase validation + store utilities
 *
 * Provides:
 *   1. validateCase(case) — validates a DebugCase against the JSON schema
 *   2. storeCase(case, casesPath) — appends to cases.jsonl
 *   3. loadCases(casesPath) — reads all cases from JSONL
 *   4. searchCases(cases, query) — basic keyword filter
 *   5. generateId(prefix) — unique ID generator
 *
 * Usage:
 *   const { validateCase, storeCase, loadCases } = require('./schema');
 *   const errors = validateCase(myCase);
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_SOURCES = ['huawei_forum', 'github_issue', 'local_git', 'manual'];
const VALID_CATEGORIES = [
  'api_usage', 'permission', 'ui_ux', 'performance',
  'build_compile', 'device_compat', 'network', 'data_storage',
  'security', 'third_party', 'configuration', 'other',
];
const VALID_STRATEGIES = ['repair', 'optimize', 'workaround', 'config_change', 'upgrade'];
const VALID_SEVERITIES = ['critical', 'major', 'minor', 'cosmetic'];

// ─── Inline schema validation (no external dependency) ─────────────────────

function isStringArray(v) {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isHttpUrl(v) {
  if (!v) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a DebugCase object against the schema rules.
 * Returns array of error messages (empty = valid).
 */
function validateCase(dc) {
  const errors = [];

  if (!dc) return ['case is null/undefined'];
  if (!dc.dc_id || !/^dc_(hm|gh|git)_[a-z0-9_]+$/.test(dc.dc_id))
    errors.push(`Invalid dc_id: "${dc.dc_id}". Must match dc_(hm|gh|git)_[a-z0-9_]+`);
  if (!dc.source || !VALID_SOURCES.includes(dc.source))
    errors.push(`Invalid source: "${dc.source}"`);
  if (dc.source_url && !isHttpUrl(dc.source_url))
    errors.push(`Invalid source_url: "${dc.source_url}"`);
  if (!dc.title || typeof dc.title !== 'string')
    errors.push('title is required (string)');
  if (!dc.symptom) errors.push('symptom object is required');
  else {
    if (!isStringArray(dc.symptom.error_signals) || dc.symptom.error_signals.length === 0)
      errors.push('symptom.error_signals must be a non-empty string array');
    if (dc.symptom.error_code && typeof dc.symptom.error_code !== 'string')
      errors.push('symptom.error_code must be a string when present');
    if (!dc.symptom.error_message) errors.push('symptom.error_message is required');
    if (dc.symptom.observed_environment && !isStringArray(dc.symptom.observed_environment))
      errors.push('symptom.observed_environment must be a string array');
    if (!dc.symptom.scenario) errors.push('symptom.scenario is required');
  }
  if (!dc.root_cause) errors.push('root_cause object is required');
  else {
    if (!VALID_CATEGORIES.includes(dc.root_cause.category))
      errors.push(`Invalid root_cause.category: "${dc.root_cause.category}"`);
    if (!dc.root_cause.analysis) errors.push('root_cause.analysis is required');
    if (dc.root_cause.confidence !== undefined &&
        (typeof dc.root_cause.confidence !== 'number' || dc.root_cause.confidence < 0 || dc.root_cause.confidence > 1))
      errors.push('root_cause.confidence must be a number between 0 and 1');
  }
  if (!dc.fix) errors.push('fix object is required');
  else {
    if (!VALID_STRATEGIES.includes(dc.fix.strategy))
      errors.push(`Invalid fix.strategy: "${dc.fix.strategy}"`);
    if (!dc.fix.description) errors.push('fix.description is required');
  }
  if (!dc.tags) errors.push('tags object is required');
  else {
    if (dc.tags.harmonyos_version && !isStringArray(dc.tags.harmonyos_version))
      errors.push('tags.harmonyos_version must be a string array');
    if (dc.tags.api_category && !isStringArray(dc.tags.api_category))
      errors.push('tags.api_category must be a string array');
    if (!isStringArray(dc.tags.bug_type) || dc.tags.bug_type.length === 0)
      errors.push('tags.bug_type must be a non-empty string array');
    if (!VALID_SEVERITIES.includes(dc.tags.severity))
      errors.push(`Invalid tags.severity: "${dc.tags.severity}"`);
    if (!isStringArray(dc.tags.keywords) || dc.tags.keywords.length === 0)
      errors.push('tags.keywords must be a non-empty string array');
  }

  return errors;
}

// ─── ID generation ─────────────────────────────────────────────────────────

function generateId(prefix = 'hm') {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `dc_${prefix}_${ts}_${rand}`;
}

// ─── Store / Load ──────────────────────────────────────────────────────────

function resolveCasesPath(customPath) {
  if (customPath) return customPath;
  const root = path.resolve(__dirname, '..', '..');
  return path.join(root, 'assets', 'debug_cases', 'cases.jsonl');
}

/**
 * Read all DebugCase entries from a JSONL file.
 */
function loadCases(casesPath) {
  const resolved = resolveCasesPath(casesPath);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Check if a new DebugCase would be a duplicate of an existing case.
 * Returns { isDuplicate, matchedBy, existingCase } or { isDuplicate: false }.
 */
function checkDuplicate(newCase, existingCases) {
  if (!existingCases || existingCases.length === 0) return { isDuplicate: false };

  // 1) Exact error_code match (strongest dedup signal)
  if (newCase.symptom?.error_code && newCase.symptom.error_code.length >= 6) {
    const exactMatch = existingCases.find(c =>
      c.symptom?.error_code === newCase.symptom.error_code
    );
    if (exactMatch) return { isDuplicate: true, matchedBy: 'error_code', existingCase: exactMatch };
  }

  // 2) Source URL match
  if (newCase.source_url) {
    const urlMatch = existingCases.find(c => c.source_url === newCase.source_url);
    if (urlMatch) return { isDuplicate: true, matchedBy: 'source_url', existingCase: urlMatch };
  }

  // 3) Signal overlap >= 60% (with at least 2 overlapping signals)
  const newSignals = (newCase.symptom?.error_signals || []).map(s => s.toLowerCase());
  if (newSignals.length >= 2) {
    for (const existing of existingCases) {
      const existingSignals = (existing.symptom?.error_signals || []).map(s => s.toLowerCase());
      if (existingSignals.length === 0) continue;
      const overlap = newSignals.filter(s => existingSignals.includes(s));
      const overlapRatio = overlap.length / Math.min(newSignals.length, existingSignals.length);
      if (overlap.length >= 2 && overlapRatio >= 0.6) {
        return { isDuplicate: true, matchedBy: `signal_overlap(${overlap.length}/${Math.min(newSignals.length, existingSignals.length)})`, existingCase: existing };
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Append a single DebugCase to cases.jsonl (with validation and dedup check).
 * Options:
 *   - force: skip dedup check (default false)
 *   - dedup: enable dedup (default true)
 * Returns { ok, errors, case, dedupSkipped? }.
 */
function storeCase(dc, casesPath, opts = {}) {
  const errors = validateCase(dc);
  if (errors.length > 0) return { ok: false, errors };

  const resolved = resolveCasesPath(casesPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Auto-set ingested_at
  if (!dc.evolver_meta) dc.evolver_meta = {};
  dc.evolver_meta.ingested_at = new Date().toISOString();

  // Dedup check (unless force)
  if (!opts.force && opts.dedup !== false) {
    const existingCases = loadCases(resolved);
    const dup = checkDuplicate(dc, existingCases);
    if (dup.isDuplicate) {
      return { ok: false, errors: [`Duplicate: matched by ${dup.matchedBy} with case ${dup.existingCase.dc_id}`], dedupSkipped: true, existingId: dup.existingCase.dc_id };
    }
  }

  fs.appendFileSync(resolved, JSON.stringify(dc) + '\n', 'utf8');
  return { ok: true, errors: [], case: dc };
}

/**
 * Save a candidate (raw scraped post) to the candidates directory.
 */
function saveCandidate(rawPost, candidateDir) {
  const dir = candidateDir || path.resolve(__dirname, '..', '..', 'assets', 'debug_cases', 'candidates');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(rawPost) + '\n', 'utf8');
  return filePath;
}

/**
 * Basic keyword search across loaded cases.
 */
function searchCases(cases, query) {
  if (!query || !query.trim()) return cases;
  const q = query.toLowerCase();
  return cases.filter(dc => {
    const haystack = [
      dc.title, dc.symptom?.error_message, dc.symptom?.scenario,
      dc.root_cause?.analysis, dc.fix?.description,
      ...(dc.tags?.keywords || []),
      ...(dc.symptom?.error_signals || []),
      dc.symptom?.error_code || '',
    ].filter(Boolean).join(' ').toLowerCase();
    // Support multiple keywords (AND matching)
    const terms = q.split(/\s+/).filter(Boolean);
    return terms.every(t => haystack.includes(t));
  });
}

// ─── Export stats ──────────────────────────────────────────────────────────

function caseStats(cases) {
  const byCategory = {};
  const bySeverity = {};
  const byApi = {};
  let total = cases.length;

  for (const dc of cases) {
    const cat = dc.root_cause?.category || 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    const sev = dc.tags?.severity || 'unknown';
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;

    const apis = dc.tags?.api_category || [];
    for (const api of apis) {
      byApi[api] = (byApi[api] || 0) + 1;
    }
  }

  return { total, byCategory, bySeverity, byApi };
}

function qualityReport(cases) {
  const issues = [];

  for (const dc of cases) {
    const id = dc.dc_id || '(unknown)';
    const confidence = dc.root_cause?.confidence;
    const fixDescription = dc.fix?.description || '';
    const apiCategories = dc.tags?.api_category || [];

    if (confidence !== undefined && confidence < 0.7) {
      issues.push({ dc_id: id, severity: 'warning', type: 'low_confidence', message: `confidence=${confidence}` });
    }
    if (dc.root_cause?.category === 'other') {
      issues.push({ dc_id: id, severity: 'warning', type: 'other_category', message: 'root cause category is too broad' });
    }
    if (fixDescription.length < 40 || fixDescription === '请参考帖子原文') {
      issues.push({ dc_id: id, severity: 'warning', type: 'thin_fix', message: 'fix description needs more detail' });
    }
    for (const api of apiCategories) {
      if (/^[|｜\s]|[|｜]\s*$/.test(api) || api.length > 30 || /\s{2,}/.test(api)) {
        issues.push({ dc_id: id, severity: 'warning', type: 'noisy_api_category', message: api });
      }
    }
    if (!dc.fix?.validation || dc.fix.validation === '需要人工验证') {
      issues.push({ dc_id: id, severity: 'info', type: 'manual_validation', message: 'validation is not executable' });
    }
  }

  const summary = {};
  for (const issue of issues) {
    summary[issue.type] = (summary[issue.type] || 0) + 1;
  }

  return { total: cases.length, issueCount: issues.length, summary, issues };
}

module.exports = {
  VALID_SOURCES,
  VALID_CATEGORIES,
  VALID_STRATEGIES,
  VALID_SEVERITIES,
  validateCase,
  generateId,
  loadCases,
  storeCase,
  saveCandidate,
  searchCases,
  caseStats,
  qualityReport,
  checkDuplicate,
};
