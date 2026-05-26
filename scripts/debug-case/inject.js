#!/usr/bin/env node
/**
 * inject.js — Inject a DebugCase directly into evolver's GEP asset store
 *
 * This is the bridge between Harmony_Evo and the evolver GEP engine.
 * It writes to:
 *   - assets/gep/candidates.jsonl (CapabilityCandidate)
 *   - assets/gep/events.jsonl (EvolutionEvent)
 *   - assets/gep/genes.json (Gene, when promoted)
 *   - assets/gep/capsules.json (Capsule, on successful fix)
 *
 * Usage:
 *   node scripts/debug-case/inject.js --as-candidate  dc_hm_001   # inject as candidate
 *   node scripts/debug-case/inject.js --as-gene       dc_hm_001   # inject as Gene
 *   node scripts/debug-case/inject.js --as-capsule    dc_hm_001   # inject as Capsule
 *   node scripts/debug-case/inject.js --status                    # show inject status
 */

const fs = require('fs');
const path = require('path');
const { loadCases } = require('./schema');
const { promoteCase } = require('./promote');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');

const EVOLVER_ROOT = path.resolve(ROOT, '..', 'evolver-main');
const GENES_PATH = path.join(EVOLVER_ROOT, 'assets', 'gep', 'genes.json');
const EVENTS_PATH = path.join(EVOLVER_ROOT, 'assets', 'gep', 'events.jsonl');
const CAPSULES_PATH = path.join(EVOLVER_ROOT, 'assets', 'gep', 'capsules.json');
const CANDIDATES_PATH = path.join(EVOLVER_ROOT, 'assets', 'gep', 'candidates.jsonl');

// ─── Helpers ──────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function appendJsonl(p, obj) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

// ─── Inject as CapabilityCandidate (safe, evolver reads this naturally) ───

function injectAsCandidate(dcId) {
  const cases = loadCases(CASES_PATH);
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return { ok: false, error: `Case "${dcId}" not found` };

  const candidate = {
    type: 'CapabilityCandidate',
    id: `cand_harmony_${dc.dc_id.replace(/^dc_hm_/, '')}`,
    title: dc.title,
    source: 'harmony_debug_case',
    created_at: new Date().toISOString(),
    signals: [...new Set([
      ...dc.symptom.error_signals,
      ...(dc.tags?.bug_type || []),
      dc.symptom.error_code,
    ].filter(Boolean))],
    tags: [
      ...dc.symptom.error_signals,
      ...(dc.tags?.api_category || []).map(a => `area:${a}`),
      `severity:${dc.tags?.severity || 'unknown'}`,
      `source:huawei_forum`,
    ],
    shape: {
      title: dc.title,
      input: `Signals: ${dc.symptom.error_signals.join(', ')}\nScenario: ${dc.symptom.scenario}`,
      output: `Fix: ${dc.fix.description.slice(0, 300)}`,
      invariants: `API Level: ${dc.fix.api_level || 'N/A'}. Validate: ${dc.fix.validation || 'Manual'}`,
      evidence: `Source: ${dc.source_url || dc.source}`,
    },
  };

  appendJsonl(CANDIDATES_PATH, candidate);
  return { ok: true, candidate };
}

// ─── Inject as Gene (direct evolution asset) ─────────────────────────────

function injectAsGene(dcId) {
  return promoteCase(dcId, {
    sourceType: 'harmony_debug_case_injection',
    eventPrefix: 'evt_harmony_gene',
  });
}

// ─── Inject as Capsule (successful fix record) ──────────────────────────

function injectAsCapsule(dcId) {
  const cases = loadCases(CASES_PATH);
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return { ok: false, error: `Case "${dcId}" not found` };

  const capsulesData = readJson(CAPSULES_PATH) || { version: 1, capsules: [] };

  const capsule = {
    type: 'Capsule',
    id: `cap_harmony_${dc.dc_id.replace(/^dc_hm_/, '')}`,
    summary: dc.title,
    category: dc.fix.strategy,
    signals: dc.symptom.error_signals,
    content: {
      problem: dc.symptom.scenario,
      analysis: dc.root_cause.analysis,
      solution: dc.fix.description,
      code: dc.fix.key_code_snippet,
      validation: dc.fix.validation,
    },
    source: {
      kind: 'harmony_debug_case',
      dc_id: dc.dc_id,
      source_url: dc.source_url,
      injected_at: new Date().toISOString(),
    },
  };

  capsulesData.capsules.push(capsule);
  writeJson(CAPSULES_PATH, capsulesData);

  return { ok: true, capsule };
}

// ─── Status ───────────────────────────────────────────────────────────────

function printStatus() {
  const cases = loadCases(CASES_PATH);

  // Check evolver connectivity
  const evolverOk = fs.existsSync(GENES_PATH);

  let existingCount = 0;
  if (evolverOk) {
    const genesData = readJson(GENES_PATH);
    existingCount = (genesData?.genes || []).filter(g => g._source?.kind === 'harmony_debug_case').length;
  }

  const evolverStatus = evolverOk ? 'connected' : 'not found';
  const evolverPath = evolverOk ? EVOLVER_ROOT : '(expected: ../evolver-main)';

  console.log(`\n  Inject Status:\n`);
  console.log(`  Cases in library:     ${cases.length}`);
  console.log(`  Evolver:              ${evolverStatus}`);
  console.log(`  Evolver path:         ${evolverPath}`);
  console.log(`  Existing harmony genes: ${existingCount}`);
  console.log(`\n  Evolver assets:\n`);
  console.log(`  GENES_PATH:        ${GENES_PATH}`);
  console.log(`  EVENTS_PATH:       ${EVENTS_PATH}`);
  console.log(`  CAPSULES_PATH:     ${CAPSULES_PATH}`);
  console.log(`  CANDIDATES_PATH:   ${CANDIDATES_PATH}`);
  console.log(`\n  Commands:\n`);
  console.log(`  Inject as candidate: node scripts/debug-case/inject.js --as-candidate <dc_id>`);
  console.log(`  Inject as gene:      node scripts/debug-case/inject.js --as-gene <dc_id>`);
  console.log(`  Inject as capsule:   node scripts/debug-case/inject.js --as-capsule <dc_id>`);
  console.log(`  Auto-promote:        node scripts/debug-case/promote.js --auto`);
  console.log('');
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status') || args.length === 0) {
    printStatus();
    return;
  }

  const asCandidate = args.indexOf('--as-candidate');
  const asGene = args.indexOf('--as-gene');
  const asCapsule = args.indexOf('--as-capsule');

  if (asCandidate >= 0 && asCandidate + 1 < args.length) {
    const dcId = args[asCandidate + 1];
    const result = injectAsCandidate(dcId);
    if (result.ok) {
      console.log(`  ✓ Injected "${dcId}" as CapabilityCandidate`);
      console.log(`  → ${CANDIDATES_PATH}`);
    } else {
      console.log(`  ✗ ${result.error}`);
    }
    return;
  }

  if (asGene >= 0 && asGene + 1 < args.length) {
    const dcId = args[asGene + 1];
    const result = injectAsGene(dcId);
    if (result.ok) {
      console.log(`  ✓ Injected "${dcId}" as Gene: ${result.gene.id}`);
      console.log(`  → ${GENES_PATH}`);
      console.log(`  Event recorded: ${result.event.id}`);
    } else {
      console.log(`  ✗ ${result.error}`);
    }
    return;
  }

  if (asCapsule >= 0 && asCapsule + 1 < args.length) {
    const dcId = args[asCapsule + 1];
    const result = injectAsCapsule(dcId);
    if (result.ok) {
      console.log(`  ✓ Injected "${dcId}" as Capsule: ${result.capsule.id}`);
      console.log(`  → ${CAPSULES_PATH}`);
    } else {
      console.log(`  ✗ ${result.error}`);
    }
    return;
  }

  console.log('Usage:');
  console.log('  node scripts/debug-case/inject.js --as-candidate <dc_id>');
  console.log('  node scripts/debug-case/inject.js --as-gene <dc_id>');
  console.log('  node scripts/debug-case/inject.js --as-capsule <dc_id>');
  console.log('  node scripts/debug-case/inject.js --status');
}

if (require.main === module) main();

module.exports = { injectAsCandidate, injectAsGene, injectAsCapsule };
