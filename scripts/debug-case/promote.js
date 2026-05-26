#!/usr/bin/env node
/**
 * promote.js — DebugCase → evolver Gene promotion system
 *
 * When a DebugCase is matched N times (default: 3), it can be promoted
 * to a Gene in evolver's assets/gep/genes.json. This bridges external
 * knowledge (forum cases) into evolver's GEP evolution cycle.
 *
 * Also records successful fix applications as Capsules.
 *
 * Usage:
 *   node scripts/debug-case/promote.js --dc-id dc_hm_001    # promote one case
 *   node scripts/debug-case/promote.js --auto               # auto-promote all eligible
 *   node scripts/debug-case/promote.js --status              # show promotion candidates
 *   node scripts/debug-case/promote.js --reset-count <id>    # reset match count
 */

const fs = require('fs');
const path = require('path');
const { loadCases } = require('./schema');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');
const GEP_ASSETS_DIR = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep');
const GENES_PATH = path.join(GEP_ASSETS_DIR, 'genes.json');
const EVENTS_PATH = path.join(GEP_ASSETS_DIR, 'events.jsonl');
const CAPSULES_PATH = path.join(GEP_ASSETS_DIR, 'capsules.json');
const CANDIDATES_PATH = path.join(GEP_ASSETS_DIR, 'candidates.jsonl');

const PROMOTE_THRESHOLD = 3;  // matched N times → eligible for promotion

// ─── Helpers ──────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function readJsonl(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function appendJsonl(p, obj) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function appendJsonlOnce(p, obj, sameRecord) {
  const existing = readJsonl(p);
  if (existing.some(sameRecord)) return false;
  appendJsonl(p, obj);
  return true;
}

function writeCases(cases) {
  const tmp = CASES_PATH + '.tmp';
  fs.writeFileSync(tmp, cases.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, CASES_PATH);
}

function findExistingGene(genesData, gene, dc) {
  const genes = genesData?.genes || [];
  return genes.find(g =>
    g.id === gene.id ||
    (g._source?.kind === 'harmony_debug_case' && g._source?.dc_id === dc.dc_id)
  );
}

function markCasePromoted(cases, dcId, geneId) {
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return false;

  dc.evolver_meta = dc.evolver_meta || {};
  dc.evolver_meta.promoted_to_gene = true;
  dc.evolver_meta.related_genes = [...new Set([
    ...(dc.evolver_meta.related_genes || []),
    geneId,
  ].filter(Boolean))];
  return true;
}

function buildPromotionEvent(dc, gene, opts = {}) {
  const eventPrefix = opts.eventPrefix || 'evt_harmony_promote';
  const sourceType = opts.sourceType || 'harmony_debug_case_promotion';
  return {
    type: 'EvolutionEvent',
    schema_version: '1.6.0',
    id: `${eventPrefix}_${Date.now()}`,
    parent: null,
    intent: gene.category === 'repair' ? 'repair' : 'optimize',
    signals: gene.signals_match,
    genes_used: [gene.id],
    mutation_id: null,
    blast_radius: { files: 0, lines: 0 },
    outcome: { status: 'success', score: 0.85 },
    source_type: sourceType,
    meta: {
      at: new Date().toISOString(),
      note: `Promoted DebugCase "${dc.title}" to Gene "${gene.id}"`,
      dc_id: dc.dc_id,
      source_url: dc.source_url,
    },
  };
}

function buildCandidate(dc, gene) {
  return {
    type: 'CapabilityCandidate',
    id: `cand_${dc.dc_id}`,
    title: dc.title,
    source: 'harmony_debug_case',
    created_at: new Date().toISOString(),
    signals: gene.signals_match,
    tags: [...gene.signals_match, ...(dc.tags?.api_category || []).map(a => `area:${a}`)],
    shape: {
      title: dc.title,
      input: `Signals: ${gene.signals_match.join(', ')}`,
      output: `Apply: ${dc.fix.description.slice(0, 200)}`,
      invariants: 'Manual validation recommended for HarmonyOS-specific fixes',
      evidence: `Source: ${dc.source_url || dc.source}`,
    },
  };
}

// ─── DebugCase → Gene converter ──────────────────────────────────────────

function caseToGene(dc) {
  const signals = [...new Set([
    ...dc.symptom.error_signals,
    ...(dc.tags?.bug_type || []),
    dc.symptom.error_code,
  ].filter(Boolean))];

  return {
    type: 'Gene',
    id: `gene_harmony_${dc.dc_id.replace(/^dc_hm_/, '')}`,
    summary: dc.title,
    category: dc.fix.strategy === 'workaround' ? 'repair' : dc.fix.strategy === 'optimize' ? 'optimize' : 'repair',
    signals_match: signals,
    preconditions: [
      `error matches one of: ${signals.slice(0, 3).join(', ')}`,
      `harmonyOS version in: ${(dc.tags?.harmonyos_version || ['any']).join(', ')}`,
    ],
    strategy: [
      dc.root_cause.analysis,
      dc.fix.description,
      ...(dc.fix.key_code_snippet ? [`Key code: ${dc.fix.key_code_snippet.slice(0, 200)}`] : []),
      ...(dc.fix.validation ? [`Validate: ${dc.fix.validation}`] : []),
    ],
    constraints: {
      max_files: 5,
      forbidden_paths: ['.git', 'node_modules'],
    },
    validation: dc.fix.validation ? [`echo "${dc.fix.validation}"`] : ['echo "manual validation required"'],
    _source: {
      kind: 'harmony_debug_case',
      dc_id: dc.dc_id,
      source: dc.source,
      source_url: dc.source_url,
      promoted_at: new Date().toISOString(),
    },
  };
}

// ─── Promotion status ────────────────────────────────────────────────────

function getEligibleCases() {
  const cases = loadCases(CASES_PATH);
  return cases.filter(dc => {
    const matched = (dc.evolver_meta?.matched_count || 0);
    const promoted = dc.evolver_meta?.promoted_to_gene || false;
    return matched >= PROMOTE_THRESHOLD && !promoted;
  });
}

function printStatus() {
  const cases = loadCases(CASES_PATH);
  const eligible = getEligibleCases();
  const promoted = cases.filter(dc => dc.evolver_meta?.promoted_to_gene);
  const total = cases.length;

  console.log(`\n  DebugCase Library Status:\n`);
  console.log(`  Total cases:     ${total}`);
  console.log(`  Promoted:        ${promoted.length}`);
  console.log(`  Eligible (≥${PROMOTE_THRESHOLD} matches): ${eligible.length}\n`);

  if (eligible.length > 0) {
    console.log('  Eligible for promotion:\n');
    for (const dc of eligible) {
      console.log(`  • ${dc.dc_id}: ${dc.title}`);
      console.log(`    Matched: ${dc.evolver_meta?.matched_count}x`);
      console.log(`    Signals: ${dc.symptom.error_signals.slice(0, 3).join(', ')}`);
      console.log('');
    }
    console.log(`  Run: node scripts/debug-case/promote.js --auto\n`);
  }

  if (promoted.length > 0) {
    console.log('  Already promoted:\n');
    for (const dc of promoted) {
      console.log(`  • ${dc.dc_id}: ${dc.title}`);
      const genes = dc.evolver_meta?.related_genes || [];
      if (genes.length > 0) console.log(`    Genes: ${genes.join(', ')}`);
      console.log('');
    }
  }
}

// ─── Promote a single case ──────────────────────────────────────────────

function promoteCase(dcId, opts = {}) {
  const cases = loadCases(CASES_PATH);
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return { ok: false, error: `Case "${dcId}" not found` };

  const gene = caseToGene(dc);

  // 1) Inject into genes.json
  const genesData = readJson(GENES_PATH);
  if (!genesData) return { ok: false, error: `Cannot read ${GENES_PATH}` };
  if (!Array.isArray(genesData.genes)) genesData.genes = [];

  const existingGene = findExistingGene(genesData, gene, dc);
  const finalGene = existingGene || gene;
  if (!existingGene) {
    genesData.genes.push(gene);
    writeJson(GENES_PATH, genesData);
  }

  // 2) Log as EvolutionEvent for new injections only.
  let event = null;
  if (!existingGene) {
    event = buildPromotionEvent(dc, finalGene, opts);
    appendJsonl(EVENTS_PATH, event);
  }

  // 3) Record as CapabilityCandidate once.
  const candidate = buildCandidate(dc, finalGene);
  const candidateAdded = appendJsonlOnce(
    CANDIDATES_PATH,
    candidate,
    c => c.id === candidate.id || (c.source === 'harmony_debug_case' && c.title === candidate.title)
  );

  // 4) Update the case metadata
  markCasePromoted(cases, dc.dc_id, finalGene.id);
  writeCases(cases);

  return { ok: true, gene: finalGene, event, existing: !!existingGene, candidateAdded };
}

// ─── Increment match count (called when a case is matched in search) ──────

function incrementMatchCount(dcId) {
  const cases = loadCases(CASES_PATH);
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return { ok: false };

  dc.evolver_meta = dc.evolver_meta || {};
  dc.evolver_meta.matched_count = (dc.evolver_meta.matched_count || 0) + 1;

  writeCases(cases);

  return { ok: true, count: dc.evolver_meta.matched_count };
}

// ─── Feedback: record fix success/failure ────────────────────────────────

/**
 * Record feedback on whether a suggested fix worked.
 * Updates case confidence and tracks success rate over time.
 *
 * @param {string} dcId - DebugCase ID
 * @param {object} outcome
 * @param {boolean} outcome.worked - whether the fix solved the problem
 * @param {string} [outcome.note] - optional user note about what happened
 * @returns {{ ok, feedback }}
 */
function recordFeedback(dcId, outcome) {
  const cases = loadCases(CASES_PATH);
  const dc = cases.find(c => c.dc_id === dcId);
  if (!dc) return { ok: false, error: `Case "${dcId}" not found` };

  dc.evolver_meta = dc.evolver_meta || {};
  const meta = dc.evolver_meta;

  // Initialize counters
  meta.successful_fixes = meta.successful_fixes || 0;
  meta.failed_fixes = meta.failed_fixes || 0;
  meta.feedback_history = meta.feedback_history || [];

  // Record this feedback
  const entry = {
    at: new Date().toISOString(),
    worked: outcome.worked,
    note: outcome.note || '',
  };
  meta.feedback_history.push(entry);

  if (outcome.worked) {
    meta.successful_fixes++;
  } else {
    meta.failed_fixes++;
  }

  // Update confidence based on feedback history
  const total = meta.successful_fixes + meta.failed_fixes;
  const baseConfidence = dc.root_cause?.confidence || 0.5;
  if (total > 0) {
    // Weighted blend: 40% original confidence, 60% empirical success rate
    const successRate = meta.successful_fixes / total;
    const empiricalWeight = Math.min(total / 10, 0.6); // max out at 60% weight after 10 feedbacks
    meta.empirical_confidence = successRate;
    meta.confidence = baseConfidence * (1 - empiricalWeight) + successRate * empiricalWeight;
  }

  // Log feedback event to evolver events
  const feedbackEvent = {
    type: 'EvolutionEvent',
    schema_version: '1.6.0',
    id: `evt_feedback_${Date.now()}`,
    parent: null,
    intent: outcome.worked ? 'reinforce' : 'revise',
    signals: dc.symptom.error_signals,
    genes_used: meta.related_genes || [],
    blast_radius: { files: 0, lines: 0 },
    outcome: {
      status: outcome.worked ? 'success' : 'failed',
      score: outcome.worked ? 0.9 : 0.1,
      note: outcome.note || `User reported fix ${outcome.worked ? 'worked' : 'did not work'}`,
    },
    source_type: 'fix_feedback',
    meta: {
      at: new Date().toISOString(),
      dc_id: dc.dc_id,
      successful_fixes: meta.successful_fixes,
      failed_fixes: meta.failed_fixes,
      empirical_confidence: meta.empirical_confidence,
    },
  };
  appendJsonl(EVENTS_PATH, feedbackEvent);

  // Save updated case
  writeCases(cases);

  return {
    ok: true,
    feedback: {
      dc_id: dcId,
      worked: outcome.worked,
      successful_fixes: meta.successful_fixes,
      failed_fixes: meta.failed_fixes,
      confidence: meta.confidence,
      empirical_confidence: meta.empirical_confidence,
    },
  };
}

/**
 * Get feedback stats for all cases.
 */
function feedbackStats() {
  const cases = loadCases(CASES_PATH);
  const withFeedback = cases.filter(c => (c.evolver_meta?.successful_fixes || 0) + (c.evolver_meta?.failed_fixes || 0) > 0);
  const totalFeedback = withFeedback.reduce((s, c) => s + (c.evolver_meta?.successful_fixes || 0) + (c.evolver_meta?.failed_fixes || 0), 0);
  const totalSuccess = withFeedback.reduce((s, c) => s + (c.evolver_meta?.successful_fixes || 0), 0);

  return {
    casesWithFeedback: withFeedback.length,
    totalFeedback,
    totalSuccess,
    successRate: totalFeedback > 0 ? totalSuccess / totalFeedback : 0,
    topFixable: withFeedback
      .filter(c => c.evolver_meta?.empirical_confidence > 0.7)
      .slice(0, 5)
      .map(c => ({ dc_id: c.dc_id, title: c.title, confidence: c.evolver_meta?.empirical_confidence })),
  };
}

function dedupeHarmonyGenes(opts = {}) {
  const genesData = readJson(GENES_PATH);
  if (!genesData || !Array.isArray(genesData.genes)) {
    return { ok: false, error: `Cannot read ${GENES_PATH}` };
  }

  const seenIds = new Set();
  const seenDcIds = new Set();
  const kept = [];
  const removed = [];

  for (const gene of genesData.genes) {
    const isHarmony = gene._source?.kind === 'harmony_debug_case';
    if (!isHarmony) {
      kept.push(gene);
      continue;
    }

    const dcId = gene._source?.dc_id || '';
    const duplicate = seenIds.has(gene.id) || (dcId && seenDcIds.has(dcId));
    if (duplicate) {
      removed.push({ id: gene.id, dc_id: dcId, summary: gene.summary });
      continue;
    }

    seenIds.add(gene.id);
    if (dcId) seenDcIds.add(dcId);
    kept.push(gene);
  }

  if (opts.write && removed.length > 0) {
    genesData.genes = kept;
    writeJson(GENES_PATH, genesData);
  }

  return { ok: true, removed, before: genesData.genes.length, after: kept.length, written: !!opts.write };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status') || args.length === 0) {
    printStatus();
    return;
  }

  if (args.includes('--auto')) {
    const eligible = getEligibleCases();
    if (eligible.length === 0) {
      console.log('No eligible cases for promotion.');
      return;
    }
    for (const dc of eligible) {
      const result = promoteCase(dc.dc_id);
      if (result.ok) {
        console.log(`  ✓ ${result.existing ? 'Synced existing' : 'Promoted'}: ${dc.dc_id} → ${result.gene.id}`);
      } else {
        console.log(`  ✗ Failed: ${dc.dc_id} — ${result.error}`);
      }
    }
    return;
  }

  const dcIdFlag = args.find(a => a.startsWith('--dc-id='));
  if (dcIdFlag) {
    const dcId = dcIdFlag.split('=')[1];
    const result = promoteCase(dcId);
    if (result.ok) {
      console.log(`  ✓ ${result.existing ? 'Synced existing promotion' : 'Promoted'}: ${dcId}`);
      console.log(`  Gene ID: ${result.gene.id}`);
      if (result.event) {
        console.log(`  Event ID: ${result.event.id}`);
        console.log(`  Event recorded in: ${EVENTS_PATH}`);
      }
    } else {
      console.log(`  ✗ ${result.error}`);
      process.exit(1);
    }
    return;
  }

  const resetFlag = args.find(a => a.startsWith('--reset-count='));
  if (resetFlag) {
    const dcId = resetFlag.split('=')[1];
    const cases = loadCases(CASES_PATH);
    const dc = cases.find(c => c.dc_id === dcId);
    if (!dc) { console.log(`Case "${dcId}" not found`); process.exit(1); }
    dc.evolver_meta = dc.evolver_meta || {};
    dc.evolver_meta.matched_count = 0;
    writeCases(cases);
    console.log(`  Reset match count for ${dcId}`);
    return;
  }

  if (args.includes('--dedupe-genes')) {
    const write = args.includes('--write');
    const result = dedupeHarmonyGenes({ write });
    if (!result.ok) {
      console.log(`  ✗ ${result.error}`);
      process.exit(1);
    }
    console.log(`\n  Harmony gene dedupe: ${result.removed.length} duplicate(s) found`);
    for (const d of result.removed) {
      console.log(`  • ${d.id} (${d.dc_id || 'unknown dc'}) ${d.summary || ''}`);
    }
    console.log(`  ${write ? 'Wrote' : 'Dry run only'}: ${GENES_PATH}\n`);
    return;
  }

  // Feedback CLI
  const feedbackIdx = args.indexOf('--feedback');
  if (feedbackIdx >= 0 && feedbackIdx + 1 < args.length) {
    const dcId = args[feedbackIdx + 1];
    const worked = args.includes('--worked') || args.includes('--success');
    const didNotWork = args.includes('--failed') || args.includes('--not-worked');
    const noteIdx = args.indexOf('--note');
    const note = noteIdx >= 0 && noteIdx + 1 < args.length ? args[noteIdx + 1] : '';

    if (!worked && !didNotWork) {
      console.log('Specify --worked or --failed');
      process.exit(1);
    }

    const result = recordFeedback(dcId, { worked: worked, note });
    if (result.ok) {
      console.log(`  ✓ Feedback recorded for ${dcId}`);
      console.log(`  Worked: ${result.feedback.worked}`);
      console.log(`  Successes: ${result.feedback.successful_fixes}, Failures: ${result.feedback.failed_fixes}`);
      console.log(`  Confidence: ${result.feedback.confidence.toFixed(2)} (empirical: ${result.feedback.empirical_confidence.toFixed(2)})`);
    } else {
      console.log(`  ✗ ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Feedback stats
  if (args.includes('--feedback-stats')) {
    const stats = feedbackStats();
    console.log(`\n  Fix Feedback Statistics:\n`);
    console.log(`  Cases with feedback: ${stats.casesWithFeedback}`);
    console.log(`  Total feedback:      ${stats.totalFeedback}`);
    console.log(`  Success rate:        ${(stats.successRate * 100).toFixed(0)}%`);
    if (stats.topFixable.length > 0) {
      console.log(`\n  Most reliable fixes:\n`);
      for (const c of stats.topFixable) {
        console.log(`  • ${c.dc_id}: ${c.title.slice(0, 50)} (confidence: ${(c.confidence * 100).toFixed(0)}%)`);
      }
    }
    console.log('');
    return;
  }

  console.log('Usage:');
  console.log('  node scripts/debug-case/promote.js --dc-id=dc_hm_xxx');
  console.log('  node scripts/debug-case/promote.js --auto');
  console.log('  node scripts/debug-case/promote.js --status');
  console.log('  node scripts/debug-case/promote.js --reset-count=dc_hm_xxx');
  console.log('  node scripts/debug-case/promote.js --feedback dc_hm_xxx --worked [--note "reason"]');
  console.log('  node scripts/debug-case/promote.js --feedback dc_hm_xxx --failed');
  console.log('  node scripts/debug-case/promote.js --feedback-stats');
  console.log('  node scripts/debug-case/promote.js --dedupe-genes [--write]');
}

if (require.main === module) main();

module.exports = { promoteCase, getEligibleCases, incrementMatchCount, caseToGene, recordFeedback, feedbackStats, dedupeHarmonyGenes };
