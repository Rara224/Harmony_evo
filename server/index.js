#!/usr/bin/env node
/**
 * server/index.js — Harmony_Evo Web Dashboard & API
 *
 * Provides:
 *   GET  /api/stats        — Library statistics
 *   GET  /api/search?q=xx  — Search cases
 *   GET  /api/cases        — All cases
 *   GET  /api/cases/:id    — Single case detail
 *   POST /api/scrape       — Trigger scraper by target count
 *   GET  /api/scrape/status— Scraper checkpoint status
 *   GET  /api/evolver      — Evolver asset injection status
 *   POST /api/promote/:id  — Promote a case to Gene
 *   POST /api/submissions  — Client shared-case review queue
 *   POST /api/dev-signals  — Hook-level development signal queue
 *   GET  /api/candidates   — Raw candidate files
 *
 * Usage:
 *   node server/index.js              # default port 3456
 *   PORT=8080 node server/index.js    # custom port
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ─── Project paths ────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'debug_cases', 'candidates');
const SUBMISSIONS_DIR = process.env.HARMONY_EVO_SUBMISSIONS_DIR || path.join(ROOT, 'assets', 'debug_cases', 'submissions');
const DEV_SIGNALS_DIR = process.env.HARMONY_EVO_DEV_SIGNALS_DIR || path.join(ROOT, 'assets', 'debug_cases', 'dev_signals');
const CHECKPOINT_FILE = path.join(CANDIDATES_DIR, '.checkpoint.json');
const GENES_PATH = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep', 'genes.json');
const EVENTS_PATH = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep', 'events.jsonl');
const CAPSULES_PATH = path.resolve(ROOT, '..', 'evolver-main', 'assets', 'gep', 'capsules.json');

// ─── Tracking imports ─────────────────────────────────────────────────────

const { incrementMatchCount } = require('../scripts/debug-case/promote');
const { record: metricsRecord } = require('../scripts/debug-case/metrics');
const { redactFields, mergeRedactionReports } = require('./redact');

let scrapeJob = null;

// ─── Data helpers ─────────────────────────────────────────────────────────

function loadCases() {
  try {
    if (!fs.existsSync(CASES_PATH)) return [];
    const raw = fs.readFileSync(CASES_PATH, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function requireClientAuth(req, res, next) {
  const required = process.env.HARMONY_EVO_UPLOAD_TOKEN || '';
  if (!required) return next();
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== required) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  return next();
}

function hasHighRiskRedaction(report) {
  const findings = report?.findings || [];
  return findings.some(f => ['api_key', 'authorization_header', 'password', 'cookie'].includes(f.type));
}

// ─── Express app ──────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: Stats ──────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const cases = loadCases();
  const byCategory = {};
  const bySeverity = {};
  const byApi = {};
  let promoted = 0;

  for (const dc of cases) {
    const cat = dc.root_cause?.category || 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const sev = dc.tags?.severity || 'unknown';
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    for (const api of (dc.tags?.api_category || [])) {
      byApi[api] = (byApi[api] || 0) + 1;
    }
    if (dc.evolver_meta?.promoted_to_gene) promoted++;
  }

  // Evolver status
  const genesData = readJson(GENES_PATH);
  const harmonyGenes = (genesData?.genes || []).filter(g => g._source?.kind === 'harmony_debug_case').length;

  // Candidate counts
  let candidateCount = 0;
  if (fs.existsSync(CANDIDATES_DIR)) {
    for (const f of fs.readdirSync(CANDIDATES_DIR)) {
      if (f.endsWith('.jsonl') && !f.startsWith('.')) {
        try {
          const raw = fs.readFileSync(path.join(CANDIDATES_DIR, f), 'utf8').trim();
          candidateCount += raw ? raw.split('\n').length : 0;
        } catch {}
      }
    }
  }

  res.json({
    totalCases: cases.length,
    byCategory,
    bySeverity,
    byApi: Object.fromEntries(Object.entries(byApi).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    promoted,
    harmonyGenes,
    candidateCount,
    evolverConnected: fs.existsSync(GENES_PATH),
  });
});

// ─── API: Search ──────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const t0 = Date.now();
  const { q, error_code, signal, top = 10, min_score = 1 } = req.query;
  const cases = loadCases();

  const query = {
    error_code: error_code || '',
    keywords: q ? q.split(/\s+/) : [],
    error_signals: signal ? [signal] : [],
    top: parseInt(top) || 10,
    min_score: parseFloat(min_score) || 1,
  };

  // If there's a raw text query, extract potential error codes
  if (q) {
    const codeMatch = q.match(/\b(\d{6,})\b/);
    if (codeMatch && !query.error_code) query.error_code = codeMatch[1];
  }

  // Score each case
  const scored = cases.map(dc => {
    let score = 0;
    const details = [];
    const qs = query.keywords.join(' ').toLowerCase();

    // Error code exact match
    if (query.error_code && dc.symptom?.error_code === query.error_code) {
      score += 100;
      details.push(`error_code exact match: ${query.error_code}`);
    }

    // Signal match
    const dcSignals = (dc.symptom?.error_signals || []).map(s => s.toLowerCase());
    for (const s of query.error_signals) {
      if (dcSignals.includes(s.toLowerCase())) {
        score += 30;
        details.push(`signal match: ${s}`);
      }
    }

    // Keyword fuzzy match
    if (qs.length > 0) {
      const haystack = [
        dc.title, dc.symptom?.scenario, dc.symptom?.error_message,
        dc.root_cause?.analysis, dc.fix?.description, dc.fix?.key_code_snippet,
        ...(dc.tags?.keywords || []), ...(dc.tags?.bug_type || []),
        ...(dc.tags?.api_category || []),
      ].filter(Boolean).join(' ').toLowerCase();

      for (const kw of query.keywords) {
        const kwl = kw.toLowerCase();
        if (haystack.includes(kwl)) {
          const boost = (dc.title || '').toLowerCase().includes(kwl) ? 20 :
                        (dc.symptom?.error_message || '').toLowerCase().includes(kwl) ? 15 : 5;
          score += boost;
          details.push(`keyword "${kw}" matched`);
        }
      }
    }

    const matchType = score >= 100 ? 'exact' : score >= 30 ? 'signal' : score > 0 ? 'fuzzy' : 'none';
    return { case: dc, score, matchType, details };
  });

  const filtered = scored.filter(s => s.score >= query.min_score).sort((a, b) => b.score - a.score);
  const results = filtered.slice(0, query.top);

  // Record system-level metrics (replaces tool-usage noise with real signal)
  if (results.length > 0) {
    metricsRecord('search_hit', { query: q || '', matches: results.length, top_score: results[0]?.score || 0 });
  } else {
    metricsRecord('search_miss', { query: q || '' });
  }

  res.json({ results, total: filtered.length, tookMs: Date.now() - t0 });
});

// ─── API: All cases (with optional filtering) ────────────────────────────

app.get('/api/cases', (req, res) => {
  const cases = loadCases();
  const { category, severity, source, limit = 50, offset = 0 } = req.query;

  let filtered = cases;
  if (category) filtered = filtered.filter(c => c.root_cause?.category === category);
  if (severity) filtered = filtered.filter(c => c.tags?.severity === severity);
  if (source) filtered = filtered.filter(c => c.source === source);

  const paginated = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ cases: paginated, total: filtered.length, offset: parseInt(offset), limit: parseInt(limit) });
});

// ─── API: Single case ────────────────────────────────────────────────────

app.get('/api/cases/:id', (req, res) => {
  const cases = loadCases();
  const dc = cases.find(c => c.dc_id === req.params.id);
  if (!dc) return res.status(404).json({ error: 'Case not found' });
  res.json(dc);
});

app.post('/api/cases/:id/match', (req, res) => {
  const result = incrementMatchCount(req.params.id);
  if (!result.ok) return res.status(404).json({ ok: false, error: 'Case not found' });
  metricsRecord('case_matched', { dc_id: req.params.id, count: result.count });
  res.json({ ok: true, dc_id: req.params.id, matched_count: result.count });
});

// ─── API: Scraper status ────────────────────────────────────────────────

app.get('/api/scrape/status', (req, res) => {
  const cp = (() => { try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')); } catch { return null; } })();
  const files = fs.existsSync(CANDIDATES_DIR) ? fs.readdirSync(CANDIDATES_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('.')) : [];
  res.json({
    checkpoint: cp || { postIds: [], savedCount: 0, targetCount: 0, inProgress: false },
    activeJob: scrapeJob,
    candidateFiles: files,
    candidatesDir: CANDIDATES_DIR,
  });
});

// ─── API: Trigger scrape ─────────────────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const body = req.body || {};
  const legacyPages = body.pages ? parseInt(body.pages, 10) : 0;
  const count = Math.max(1, parseInt(body.count || body.limit || body.maxPosts || (legacyPages ? legacyPages * 9 : 30), 10) || 30);
  const concurrency = Math.max(1, Math.min(8, parseInt(body.concurrency || body.detailConcurrency || 3, 10) || 3));

  if (scrapeJob) {
    return res.status(409).json({ ok: false, error: `Scraper already running for ${scrapeJob.count} posts`, activeJob: scrapeJob });
  }

  try {
    const { scrapeForum } = require('../scripts/scrapers/huawei-forum');
    scrapeJob = { count, concurrency, started_at: new Date().toISOString() };
    // Run in background, return immediately
    scrapeForum({ maxPosts: count, detailConcurrency: concurrency, headless: true }).then(stats => {
      console.log(`[Scraper] Done: ${stats.new} new, ${stats.extracted} total`);
      metricsRecord('scraper_run', { count, new: stats.new, errors: stats.errors, duplicates: stats.duplicates });
    }).catch(e => {
      console.error(`[Scraper] Error: ${e.message}`);
    }).finally(() => {
      scrapeJob = null;
    });
    res.json({ ok: true, count, concurrency, message: `Scraping up to ${count} posts in background...` });
  } catch (e) {
    scrapeJob = null;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: Evolver status ─────────────────────────────────────────────────

app.get('/api/evolver', (req, res) => {
  const genesData = readJson(GENES_PATH);
  const capsulesData = readJson(CAPSULES_PATH);
  const harmonyGenes = (genesData?.genes || []).filter(g => g._source?.kind === 'harmony_debug_case');
  const harmonyCaps = (capsulesData?.capsules || []).filter(c => c.source?.kind === 'harmony_debug_case');

  let harmonyEvents = 0;
  try {
    if (fs.existsSync(EVENTS_PATH)) {
      const raw = fs.readFileSync(EVENTS_PATH, 'utf8').trim();
      harmonyEvents = raw ? raw.split('\n').filter(l => l.includes('harmony_')).length : 0;
    }
  } catch {}

  res.json({
    connected: fs.existsSync(GENES_PATH),
    genesPath: GENES_PATH,
    harmonyGenes: harmonyGenes.map(g => ({ id: g.id, summary: g.summary, signals: (g.signals_match || []).slice(0, 5) })),
    harmonyCapsules: harmonyCaps.map(c => ({ id: c.id, summary: c.summary })),
    harmonyEvents,
    availableForPromotion: loadCases().filter(dc => (dc.evolver_meta?.matched_count || 0) >= 3 && !dc.evolver_meta?.promoted_to_gene).length,
  });
});

// ─── API: Promote a case ─────────────────────────────────────────────────

app.post('/api/promote/:id', (req, res) => {
  const { injectAsGene } = require('../scripts/debug-case/inject');
  const result = injectAsGene(req.params.id);
  if (result.ok) {
    res.json({ ok: true, geneId: result.gene.id });
  } else {
    res.status(400).json({ ok: false, error: result.error });
  }
});

// ─── API: Record fix feedback ────────────────────────────────────────────

app.post('/api/feedback/:id', (req, res) => {
  const { recordFeedback, feedbackStats } = require('../scripts/debug-case/promote');
  const { worked, note } = req.body || {};
  if (typeof worked !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'body.worked (boolean) is required' });
  }
  const result = recordFeedback(req.params.id, { worked, note: note || '' });
  if (result.ok) {
    res.json({ ok: true, ...result.feedback });
  } else {
    res.status(404).json({ ok: false, error: result.error });
  }
});

app.get('/api/feedback/stats', (req, res) => {
  const { feedbackStats } = require('../scripts/debug-case/promote');
  res.json(feedbackStats());
});

// ─── API: Client submissions (review queue, not direct publish) ───────────

app.post('/api/submissions', requireClientAuth, (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  const problem = String(body.problem || '').trim();
  if (!title || !problem) {
    return res.status(400).json({ ok: false, error: 'title and problem are required' });
  }

  const serverRedacted = redactFields({
    title,
    problem,
    solution: body.solution || '',
    evidence: body.evidence || '',
  }, { maxLength: 8000 });
  const redaction = mergeRedactionReports(body.redaction || {}, serverRedacted.report);
  const status = hasHighRiskRedaction(redaction) ? 'quarantined' : 'submitted';
  const record = {
    id: safeId('sub'),
    status,
    submitted_at: new Date().toISOString(),
    source: body.source || 'client',
    title: serverRedacted.fields.title.slice(0, 200),
    problem: serverRedacted.fields.problem.slice(0, 8000),
    solution: serverRedacted.fields.solution.slice(0, 6000),
    evidence: serverRedacted.fields.evidence.slice(0, 4000),
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 30).map(String) : [],
    signals: Array.isArray(body.signals) ? body.signals.slice(0, 30).map(String) : [],
    profile: body.profile || {},
    redaction,
    client: body.client || {},
    review: {
      note: status === 'quarantined'
        ? 'High-risk redaction findings require review before publishing.'
        : 'Pending review before publishing.',
    },
  };

  const date = new Date().toISOString().slice(0, 10);
  const fp = path.join(SUBMISSIONS_DIR, `submitted_${date}.jsonl`);
  appendJsonl(fp, record);
  metricsRecord('client_submission', { status, signals: record.signals.length });
  res.json({ ok: true, id: record.id, status, path: fp });
});

app.get('/api/submissions', requireClientAuth, (req, res) => {
  if (!fs.existsSync(SUBMISSIONS_DIR)) {
    return res.json({ files: [], total: 0 });
  }
  let total = 0;
  const files = fs.readdirSync(SUBMISSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(filename => {
      const fp = path.join(SUBMISSIONS_DIR, filename);
      const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
      total += lines.length;
      return { filename, count: lines.length };
    });
  res.json({ files, total, submissionsDir: SUBMISSIONS_DIR });
});

// ─── API: Hook-level development signals ─────────────────────────────────

app.post('/api/dev-signals', requireClientAuth, (req, res) => {
  const body = req.body || {};
  const serverRedacted = redactFields({
    title: body.title || '',
    excerpt: body.excerpt || '',
  }, { maxLength: 5000 });
  const redaction = mergeRedactionReports(body.redaction || {}, serverRedacted.report);
  const status = hasHighRiskRedaction(redaction) ? 'quarantined' : 'accepted';
  const score = Math.max(0, Math.min(1, Number(body.quality?.score || 0)));
  const record = {
    id: safeId('sig'),
    event_id: String(body.event_id || '').slice(0, 120) || safeId('evt'),
    session_id: String(body.session_id || '').slice(0, 160),
    status,
    received_at: new Date().toISOString(),
    captured_at: body.captured_at || '',
    source: body.source || 'client_hook',
    hook_event: body.hook_event || body.kind || '',
    kind: body.kind || '',
    title: serverRedacted.fields.title.slice(0, 200),
    excerpt: serverRedacted.fields.excerpt.slice(0, 5000),
    signals: Array.isArray(body.signals) ? body.signals.slice(0, 30).map(String) : [],
    error_codes: Array.isArray(body.error_codes) ? body.error_codes.slice(0, 20).map(String) : [],
    relevant: !!body.relevant,
    tool: body.tool || {},
    search: body.search || {},
    quality: {
      score,
      reasons: Array.isArray(body.quality?.reasons) ? body.quality.reasons.slice(0, 20).map(String) : [],
      is_failure: !!body.quality?.is_failure,
      uploadable: !!body.quality?.uploadable,
      candidate_ready: !!body.quality?.candidate_ready,
    },
    profile: body.profile || {},
    redaction,
    client: body.client || {},
  };

  const date = new Date().toISOString().slice(0, 10);
  const fp = path.join(DEV_SIGNALS_DIR, `signals_${date}.jsonl`);
  appendJsonl(fp, record);
  metricsRecord('dev_signal', {
    status,
    score: record.quality.score,
    signals: record.signals.length,
    candidate_ready: record.quality.candidate_ready,
  });
  res.json({ ok: true, id: record.id, event_id: record.event_id, status, path: fp });
});

app.get('/api/dev-signals', requireClientAuth, (req, res) => {
  if (!fs.existsSync(DEV_SIGNALS_DIR)) {
    return res.json({ files: [], total: 0, latest: [] });
  }
  let total = 0;
  const records = [];
  const files = fs.readdirSync(DEV_SIGNALS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(filename => {
      const fp = path.join(DEV_SIGNALS_DIR, filename);
      const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
      total += lines.length;
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          records.push({ ...record, _file: filename });
        } catch {}
      }
      return { filename, count: lines.length };
    });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  records.sort((a, b) => String(b.received_at || b.captured_at || '').localeCompare(String(a.received_at || a.captured_at || '')));
  res.json({
    files,
    total,
    latest: records.slice(0, limit),
    devSignalsDir: DEV_SIGNALS_DIR,
  });
});

// ─── API: System health ──────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const { healthSnapshot, aggregateMetrics } = require('../scripts/debug-case/metrics');
  const { feedbackStats } = require('../scripts/debug-case/promote');

  const cases = loadCases();
  const promoted = cases.filter(c => c.evolver_meta?.promoted_to_gene).length;
  const fb = feedbackStats();
  const agg = aggregateMetrics(168); // past week

  const health = healthSnapshot({
    totalCases: cases.length,
    searchActivity: agg.by_type?.search_hit || 0,
    feedbackSuccess: fb.totalSuccess,
    feedbackTotal: fb.totalFeedback,
    promotedCount: promoted,
    scraperRuns: agg.by_type?.scraper_run || 0,
  });

  res.json({ ...health, recent_metrics: agg });
});

// ─── API: Extract candidates → DebugCases ────────────────────────────────

app.post('/api/extract', (req, res) => {
  const { execSync } = require('child_process');
  const script = path.join(ROOT, 'scripts', 'scrapers', 'llm-extractor.js');
  try {
    const out = execSync(`node "${script}" --template`, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const lines = out.trim().split('\n').filter(l => l.includes('✓ Stored') || l.includes('Done:'));
    const stored = lines.filter(l => l.includes('Stored')).length;
    res.json({ ok: true, stored, message: `${stored} cases extracted` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: Candidates ─────────────────────────────────────────────────────

app.get('/api/candidates', (req, res) => {
  if (!fs.existsSync(CANDIDATES_DIR)) return res.json({ files: [] });
  const files = fs.readdirSync(CANDIDATES_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('.') && !f.startsWith('.'))
    .map(f => {
      const fp = path.join(CANDIDATES_DIR, f);
      try {
        const content = fs.readFileSync(fp, 'utf8').trim();
        const lines = content ? content.split('\n').filter(Boolean) : [];
        const posts = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return {
          filename: f,
          path: fp,
          count: posts.length,
          posts: posts.slice(0, 20).map(p => ({ id: p.id, title: p.title, source_url: p.source_url })),
        };
      } catch { return { filename: f, count: 0, posts: [] }; }
    });
  res.json({ files });
});

// ─── Serve frontend ──────────────────────────────────────────────────────

// express.static handles index.html at / already. This is just for SPA deep links.
app.use('/assets', express.static(path.join(ROOT, 'assets')));

// ─── Start ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  Harmony_Evo Dashboard                   ║
  ║                                          ║
  ║  Local:   http://localhost:${String(PORT).padEnd(5)}           ║
  ║  API:     http://localhost:${String(PORT).padEnd(5)}/api/stats ║
  ╚══════════════════════════════════════════╝
  `);
});
