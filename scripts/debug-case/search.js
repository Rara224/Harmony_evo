#!/usr/bin/env node
/**
 * search.js — DebugCase matching engine
 *
 * Three-tier matching:
 *   1. EXACT match: error_code match (e.g. "907135702")
 *   2. SIGNAL match: error_signals overlap (e.g. "push_token_null")
 *   3. FUZZY match: keyword + tag search across all fields
 *
 * Usage:
 *   node scripts/debug-case/search.js --error-code 907135702
 *   node scripts/debug-case/search.js --signal push_token_null
 *   node scripts/debug-case/search.js --message "getToken returns null"
 *   node scripts/debug-case/search.js --query "权限 闪退"         # Chinese keywords
 *   node scripts/debug-case/search.js --top 5                     # show top 5
 */

const path = require('path');
const { loadCases, searchCases } = require('./schema');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');

// ─── Scoring ──────────────────────────────────────────────────────────────

/**
 * Score a case against a query with multiple dimensions.
 * Returns { score, matchType, details }.
 */
function scoreCase(dc, query) {
  let score = 0;
  let matchDetails = [];

  // 1) Error code exact match (highest weight)
  if (query.error_code && dc.symptom?.error_code === query.error_code) {
    score += 100;
    matchDetails.push(`exact error_code: ${query.error_code}`);
  }

  // 2) Error signal overlap
  if (Array.isArray(query.error_signals) && query.error_signals.length > 0) {
    const dcSignals = (dc.symptom?.error_signals || []).map(s => s.toLowerCase());
    const querySignals = query.error_signals.map(s => s.toLowerCase());
    const overlap = querySignals.filter(s => dcSignals.includes(s));
    if (overlap.length > 0) {
      const weight = 30 * overlap.length;
      score += weight;
      matchDetails.push(`signal match: ${overlap.join(', ')} (weight: ${weight})`);
    }
  }

  // 3) Keyword fuzzy match across all text fields
  if (query.keywords && query.keywords.length > 0) {
    const haystack = buildSearchText(dc).toLowerCase();
    for (const kw of query.keywords) {
      const kwl = kw.toLowerCase();
      // Exact phrase match
      if (haystack.includes(kwl)) {
        // Boost for field-specific matches
        const titleMatch = (dc.title || '').toLowerCase().includes(kwl);
        const signalMatch = (dc.symptom?.error_message || '').toLowerCase().includes(kwl);
        const codeMatch = (dc.tags?.keywords || []).some(k => k.toLowerCase().includes(kwl));
        const fieldBoost = titleMatch ? 20 : signalMatch ? 15 : codeMatch ? 10 : 5;
        score += fieldBoost;
        matchDetails.push(`keyword "${kwl}" matched (boost: ${fieldBoost})`);
      }
    }
  }

  // 4) Tag category overlap
  if (query.api_category && dc.tags?.api_category) {
    const overlap = query.api_category.filter(a => dc.tags.api_category.includes(a));
    if (overlap.length > 0) {
      score += 10 * overlap.length;
      matchDetails.push(`api_category match: ${overlap.join(', ')}`);
    }
  }

  if (query.harmonyos_version && dc.tags?.harmonyos_version) {
    const overlap = query.harmonyos_version.filter(v => dc.tags.harmonyos_version.includes(v));
    if (overlap.length > 0) {
      score += 5 * overlap.length;
      matchDetails.push(`harmonyos_version match: ${overlap.join(', ')}`);
    }
  }

  // Determine match type
  let matchType = 'fuzzy';
  if (score >= 100) matchType = 'exact';
  else if (score >= 30) matchType = 'signal';
  else if (score > 0) matchType = 'fuzzy';

  return { score, matchType, details: matchDetails };
}

function buildSearchText(dc) {
  return [
    dc.title || '',
    dc.symptom?.error_message || '',
    dc.symptom?.scenario || '',
    dc.symptom?.error_code || '',
    dc.root_cause?.analysis || '',
    dc.fix?.description || '',
    dc.fix?.key_code_snippet || '',
    ...(dc.tags?.keywords || []),
    ...(dc.symptom?.error_signals || []),
    ...(dc.tags?.bug_type || []),
    ...(dc.tags?.api_category || []),
  ].filter(Boolean).join(' ');
}

// ─── Main search function ────────────────────────────────────────────────

/**
 * Search the case library with structured query.
 *
 * @param {object} query
 * @param {string} [query.error_code] - HarmonyOS error code
 * @param {string[]} [query.error_signals] - error signal tags
 * @param {string[]} [query.keywords] - natural language keywords
 * @param {string[]} [query.api_category] - API category filter
 * @param {string[]} [query.harmonyos_version] - OS version filter
 * @param {number} [query.top=5] - max results
 * @param {number} [query.min_score=1] - minimum score threshold
 * @returns {{ results: Array, total: number, took_ms: number }}
 */
function search(query = {}) {
  const t0 = Date.now();
  const allCases = loadCases(CASES_PATH);
  const top = query.top || 5;
  const minScore = query.min_score || 1;

  // Build query object for scoring
  const q = {
    error_code: query.error_code || '',
    error_signals: Array.isArray(query.error_signals) ? query.error_signals :
                   query.signal ? [query.signal] : [],
    keywords: Array.isArray(query.keywords) ? query.keywords :
              query.keyword ? [query.keyword] :
              query.message ? [query.message] :
              query.query ? query.query.split(/\s+/) : [],
    api_category: Array.isArray(query.api_category) ? query.api_category : [],
    harmonyos_version: Array.isArray(query.harmonyos_version) ? query.harmonyos_version : [],
  };

  // If there's a raw text query, also extract potential error codes
  const rawText = q.keywords.join(' ');
  const errorCodeMatch = rawText.match(/\b(\d{6,})\b/);
  if (errorCodeMatch && !q.error_code) {
    q.error_code = errorCodeMatch[1];
  }

  // Score all cases
  const scored = allCases.map(dc => ({
    case: dc,
    ...scoreCase(dc, q),
  }));

  // Filter and sort
  const filtered = scored
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const results = filtered.slice(0, top);
  const tookMs = Date.now() - t0;

  return { results, total: filtered.length, took_ms: tookMs };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const query = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--error-code': query.error_code = args[++i]; break;
      case '--signal': query.error_signals = [args[++i]]; break;
      case '--message': query.keywords = [args[++i]]; break;
      case '--query': query.keywords = args[++i].split(/\s+/); break;
      case '--api-category': query.api_category = args[++i].split(','); break;
      case '--version': query.harmonyos_version = args[++i].split(','); break;
      case '--top': query.top = parseInt(args[++i]) || 5; break;
      case '--min-score': query.min_score = parseFloat(args[++i]); break;
      case '--json': query.format = 'json'; break;
      case '--help':
      case '-h':
        console.log(`
Usage: node scripts/debug-case/search.js [options]

Options:
  --error-code <code>    Exact error code match (e.g. 907135702)
  --signal <name>        Error signal tag (e.g. push_token_null)
  --message <text>       Error message text (fuzzy match)
  --query <text>         Chinese/English keywords (space-separated)
  --api-category <cat>   Filter by API category (comma-separated)
  --version <ver>        Filter by HarmonyOS version (comma-separated)
  --top <N>              Max results (default: 5)
  --min-score <N>        Minimum score threshold (default: 1)
  --json                 Output raw JSON
  --help                 Show this help
        `.trim());
        process.exit(0);
    }
  }

  return query;
}

function printResults(result) {
  if (result.total === 0) {
    console.log(`\n  No matching cases found (${result.took_ms}ms)`);
    console.log('  Try broader keywords or check assets/debug_cases/cases.jsonl\n');
    return;
  }

  console.log(`\n  Found ${result.total} matching case(s) in ${result.took_ms}ms:\n`);

  for (const hit of result.results) {
    const dc = hit.case;
    const matchTag = hit.matchType === 'exact' ? 'EXACT' : hit.matchType === 'signal' ? 'SIGNAL' : 'FUZZY';
    console.log(`  [${matchTag}] (score: ${hit.score}) ${dc.dc_id}`);
    console.log(`  ├─ Title: ${dc.title}`);
    if (dc.symptom?.error_code) console.log(`  ├─ Error Code: ${dc.symptom.error_code}`);
    console.log(`  ├─ Scenario: ${(dc.symptom?.scenario || '').slice(0, 100)}`);
    console.log(`  ├─ Root Cause: ${(dc.root_cause?.analysis || '').slice(0, 100)}`);
    console.log(`  ├─ Fix: ${(dc.fix?.description || '').slice(0, 120)}`);
    if (dc.source_url) console.log(`  └─ Source: ${dc.source_url}`);
    console.log('');
  }

  console.log(`  Match details:`);
  for (const hit of result.results) {
    console.log(`  ${hit.case.dc_id}:`);
    for (const d of hit.details) {
      console.log(`    • ${d}`);
    }
  }
  console.log('');
}

function main() {
  const query = parseArgs();
  const result = search(query);

  if (query.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResults(result);
  }
}

if (require.main === module) main();

module.exports = { search, scoreCase, loadCases };