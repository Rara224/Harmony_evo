const { compactText } = require('./redact');

function summarizeHit(hit, index) {
  const dc = hit.case || hit;
  const title = dc.title || '(untitled)';
  const root = dc.root_cause?.analysis || '';
  const fix = dc.fix?.description || '';
  const validation = dc.fix?.validation || '';
  const source = dc.source_url || dc.source || '';
  const score = hit.score != null ? `score=${hit.score}` : '';
  const match = hit.matchType ? `match=${hit.matchType}` : '';
  return [
    `${index + 1}. ${title} (${[match, score].filter(Boolean).join(', ')})`,
    dc.symptom?.error_code ? `   error_code: ${dc.symptom.error_code}` : '',
    root ? `   root_cause: ${compactText(root, 220)}` : '',
    fix ? `   fix: ${compactText(fix, 260)}` : '',
    validation ? `   validation: ${compactText(validation, 160)}` : '',
    source ? `   source: ${source}` : '',
  ].filter(Boolean).join('\n');
}

function formatSearchContext(result, opts = {}) {
  const rawHits = result?.results || [];
  const exactHits = rawHits.filter(hit => hit.matchType === 'exact' || Number(hit.score || 0) >= 100);
  const hits = exactHits.length ? exactHits : rawHits;
  if (!hits.length) return '';
  const limit = opts.limit || 3;
  return [
    '[Harmony_Evo Asset Matches]',
    'Use these as prior repair evidence. Verify version and project fit before editing.',
    ...hits.slice(0, limit).map(summarizeHit),
  ].join('\n');
}

function formatMcpSearch(result) {
  const hits = result?.results || [];
  if (!hits.length) return 'No matching Harmony_Evo assets found.';
  return [
    `Found ${result.total ?? hits.length} matching asset(s).`,
    ...hits.map(summarizeHit),
  ].join('\n\n');
}

function formatStatus(stats, config) {
  return [
    `Harmony_Evo server: ${config.serverUrl}`,
    `Cases: ${stats.totalCases ?? 0}`,
    `Candidates: ${stats.candidateCount ?? 0}`,
    `Harmony genes: ${stats.harmonyGenes ?? 0}`,
    `Evolver connected: ${stats.evolverConnected ? 'yes' : 'no'}`,
  ].join('\n');
}

module.exports = { formatSearchContext, formatMcpSearch, formatStatus };
