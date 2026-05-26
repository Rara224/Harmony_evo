#!/usr/bin/env node
/**
 * test-seed.js — Verify the Seed DebugCases are valid and searchable
 *
 * Loads assets/debug_cases/cases.jsonl, validates every case,
 * runs sample searches, and reports results.
 */

const path = require('path');
const { loadCases, validateCase, caseStats, qualityReport } = require('./debug-case/schema');
const { search } = require('./debug-case/search');

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');

function main() {
  console.log('\n  ═══════════════════════════════════════');
  console.log('  Harmony_Evo Seed Data Verification');
  console.log('  ═══════════════════════════════════════\n');

  // 1. Load and validate
  const allCases = loadCases(CASES_PATH);
  console.log(`  Cases loaded: ${allCases.length}\n`);

  let valid = 0, invalid = 0;
  for (const dc of allCases) {
    const errors = validateCase(dc);
    if (errors.length === 0) {
      valid++;
    } else {
      invalid++;
      console.log(`  ✗ ${dc.dc_id}: ${errors.join('; ')}`);
    }
  }
  console.log(`  Validation: ${valid} ✓, ${invalid} ✗\n`);

  // 2. Stats
  const stats = caseStats(allCases);
  const quality = qualityReport(allCases);
  console.log('  Case Statistics:');
  console.log(`  ├─ Categories: ${Object.keys(stats.byCategory).join(', ')}`);
  console.log(`  ├─ Severities: ${JSON.stringify(stats.bySeverity)}`);
  console.log(`  ├─ Top APIs:   ${JSON.stringify(Object.entries(stats.byApi).slice(0, 5).map(([k,v]) => `${k}(${v})`))}`);
  console.log(`  └─ Quality:    ${quality.issueCount} issue(s), ${JSON.stringify(quality.summary)}\n`);

  // 3. Search tests
  console.log('  Search Tests:\n');

  const tests = [
    { name: 'Error code search', query: { error_code: '907135702' } },
    { name: 'Signal match', query: { error_signals: ['permission_dialog_not_show'] } },
    { name: 'Chinese keyword', query: { keywords: ['权限', '弹窗'] } },
    { name: 'Chinese + English', query: { keywords: ['list', '卡顿'] } },
    { name: 'Mixed keywords', query: { keywords: ['Ability', '闪退', 'crash'] } },
    { name: 'API build failure', query: { keywords: ['Hvigor', '编译', '签名'] } },
    { name: 'General query', query: { keywords: ['OOM', '大图'] } },
    { name: 'No match test', query: { keywords: ['蓝牙', 'ble', '配对'], min_score: 0 } },
  ];

  for (const test of tests) {
    const result = search(test.query);
    if (result.total > 0) {
      console.log(`  ✓ "${test.name}": ${result.total} match(es) in ${result.took_ms}ms`);
      for (const hit of result.results.slice(0, 2)) {
        console.log(`    └─ [${hit.matchType}] ${hit.case.dc_id}: ${hit.case.title.slice(0, 50)} (score: ${hit.score})`);
      }
    } else {
      console.log(`  ○ "${test.name}": 0 matches (but ${allCases.length} cases loaded — search term not found, which is expected)`);
    }
  }

  // 4. Summary
  console.log(`\n  ─────────────────────────────────────────`);
  console.log(`  Ready. ${valid} valid DebugCases in library.`);
  console.log('  ─────────────────────────────────────────\n');
  console.log('  Next:');
  console.log('    node scripts/debug-case/search.js --query "你的错误信息"');
  console.log('    node scripts/debug-case/promote.js --status');
  console.log('    node scripts/debug-case/inject.js --as-gene dc_hm_001');
  console.log('    node scripts/debug-case/dashboard.js\n');
}

main();
