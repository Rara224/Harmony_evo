#!/usr/bin/env node
/**
 * quality.js — DebugCase validation and quality report.
 *
 * Usage:
 *   node scripts/debug-case/quality.js
 *   node scripts/debug-case/quality.js --json
 *   node scripts/debug-case/quality.js --fail-on-invalid
 */

const path = require('path');
const { loadCases, validateCase, qualityReport } = require('./schema');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const failOnInvalid = args.includes('--fail-on-invalid');

  const cases = loadCases(CASES_PATH);
  const validation = [];
  for (const dc of cases) {
    const errors = validateCase(dc);
    if (errors.length > 0) validation.push({ dc_id: dc.dc_id || '(unknown)', errors });
  }

  const quality = qualityReport(cases);
  const report = {
    cases: cases.length,
    invalid: validation.length,
    validation,
    quality,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n  DebugCase Quality Report\n`);
    console.log(`  Cases:            ${report.cases}`);
    console.log(`  Invalid cases:    ${report.invalid}`);
    console.log(`  Quality issues:   ${quality.issueCount}`);
    console.log(`  Issue summary:    ${JSON.stringify(quality.summary)}`);

    if (validation.length > 0) {
      console.log(`\n  Invalid cases:\n`);
      for (const item of validation) {
        console.log(`  • ${item.dc_id}: ${item.errors.join('; ')}`);
      }
    }

    if (quality.issues.length > 0) {
      console.log(`\n  Top quality issues:\n`);
      for (const issue of quality.issues.slice(0, 20)) {
        console.log(`  • [${issue.type}] ${issue.dc_id}: ${issue.message}`);
      }
      if (quality.issues.length > 20) {
        console.log(`  ... ${quality.issues.length - 20} more`);
      }
    }
    console.log('');
  }

  if (failOnInvalid && validation.length > 0) process.exit(1);
}

if (require.main === module) main();
