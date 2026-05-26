#!/usr/bin/env node
/**
 * test-functional.js — focused non-network checks for core Harmony_Evo flows.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { search } = require('./debug-case/search');
const { loadCases, validateCase, qualityReport } = require('./debug-case/schema');
const { getEligibleCases, dedupeHarmonyGenes } = require('./debug-case/promote');
const { normalizeScrapeOptions, selectPostsToScrape, stripHtml, topicListItemToPost } = require('./scrapers/huawei-forum');

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(ROOT, 'assets', 'debug_cases', 'cases.jsonl');

function readCasesDirect() {
  return fs.readFileSync(CASES_PATH, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function matchedCount(dcId) {
  const dc = readCasesDirect().find(c => c.dc_id === dcId);
  return dc?.evolver_meta?.matched_count || 0;
}

async function waitForServer(port, child) {
  const url = `http://127.0.0.1:${port}/api/stats`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('server did not start in time');
}

async function withServer(fn, extraEnv = {}) {
  const port = 4567;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

async function main() {
  const cases = loadCases(CASES_PATH);
  assert(cases.length > 0, 'case library should not be empty');
  for (const dc of cases) {
    assert.deepStrictEqual(validateCase(dc), [], `invalid case ${dc.dc_id}`);
  }

  const exact = search({ error_code: '907135702' });
  assert.strictEqual(exact.results[0]?.case?.dc_id, 'dc_hm_001', 'exact error code search should hit dc_hm_001');

  const quality = qualityReport(cases);
  assert.strictEqual(quality.total, cases.length, 'quality report should cover all cases');

  const scrapeCfg = normalizeScrapeOptions({ count: 30, detailConcurrency: 4 });
  assert.strictEqual(scrapeCfg.maxPosts, 30, 'count maps to maxPosts');
  assert.strictEqual(scrapeCfg.detailConcurrency, 4, 'concurrency should be configurable');
  const legacyCfg = normalizeScrapeOptions({ maxPages: 3 });
  assert.strictEqual(legacyCfg.maxPosts, 27, 'legacy pages maps to estimated post count');

  const posts = [
    { id: 'p1', url: 'u1', isResolved: true },
    { id: 'p2', url: 'u2', isResolved: false },
    { id: 'p3', url: 'u3', isResolved: true },
    { id: 'p4', url: 'u3', isResolved: true },
    { id: 'p5', url: 'u5', isResolved: true },
  ];
  const selected = selectPostsToScrape(posts, { postIds: ['p1'] }, new Set(['u5']), 10);
  assert.deepStrictEqual(selected.map(p => p.id), ['p3'], 'scraper selection filters checkpoint, unresolved, duplicates, and existing raw sources');
  const apiPost = topicListItemToPost({
    topicId: '0208215103295576228',
    fid: '0109140870620153026',
    postId: '0308215103295576130',
    title: '模拟器上用release证书能正常运行吗？',
    content: '<div class="cke-article">正文&nbsp;内容</div>',
    topicTagInfoList: [{ tagName: 'HarmonyOS 6' }],
    solved: 1,
  });
  assert.strictEqual(apiPost.id, 'hm_0208215103295576228', 'list API topic id should become stable scraper id');
  assert.strictEqual(apiPost.isResolved, true, 'list API solved flag should map to isResolved');
  assert.strictEqual(apiPost.postId, '0308215103295576130', 'list API postId should be retained for answer lookup');
  assert.deepStrictEqual(apiPost.tags, ['HarmonyOS 6'], 'list API tags should be retained');
  assert.strictEqual(apiPost.content, '正文 内容', 'list API content should be stripped to text');
  assert.strictEqual(
    apiPost.url,
    'https://developer.huawei.com/consumer/cn/forum/topic/0208215103295576228?fid=0109140870620153026',
    'list API topic should map to detail URL'
  );
  assert.strictEqual(stripHtml('<p>A&nbsp;&amp;&nbsp;B</p><div>C</div>'), 'A & B\nC', 'HTML stripper should preserve readable text');

  const geneDedupe = dedupeHarmonyGenes({ write: false });
  assert(geneDedupe.ok, 'gene dedupe dry-run should read GEP genes');
  assert.strictEqual(geneDedupe.removed.length, 0, 'Harmony genes should not have duplicates');

  const submissionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-evo-submissions-'));
  const devSignalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-evo-dev-signals-'));
  await withServer(async base => {
    const before = matchedCount('dc_hm_001');
    const stats = await fetch(`${base}/api/stats`).then(r => r.json());
    assert(stats.totalCases >= cases.length, 'stats should report case count');

    const apiSearch = await fetch(`${base}/api/search?error_code=907135702`).then(r => r.json());
    assert.strictEqual(apiSearch.results[0]?.case?.dc_id, 'dc_hm_001', 'API search should hit dc_hm_001');
    assert.strictEqual(matchedCount('dc_hm_001'), before, 'GET /api/search must not mutate matched_count');

    const scrapeStatus = await fetch(`${base}/api/scrape/status`).then(r => r.json());
    assert(scrapeStatus.checkpoint, 'scrape status should include checkpoint');
    assert(Array.isArray(scrapeStatus.candidateFiles), 'scrape status should include candidate files');

    const evo = await fetch(`${base}/api/evolver`).then(r => r.json());
    assert.strictEqual(typeof evo.connected, 'boolean', 'evolver status should include connection state');
    assert(Array.isArray(evo.harmonyGenes), 'evolver status should include harmony genes');

    const unauthorized = await fetch(`${base}/api/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', problem: 'y' }),
    });
    assert.strictEqual(unauthorized.status, 401, 'submissions should honor optional upload token');

    const submitted = await fetch(`${base}/api/submissions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-upload-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'functional_test',
        title: '权限申请失败',
        problem: 'requestPermissionsFromUser 报错 password=12345678',
        solution: 'Authorization: Bearer sk-test_secret_1234567890',
        redaction: { findings: [] },
      }),
    }).then(r => r.json());
    assert.strictEqual(submitted.ok, true, 'submissions endpoint should accept valid uploads');
    assert.strictEqual(submitted.status, 'quarantined', 'server-side redaction should quarantine high-risk findings');

    const list = await fetch(`${base}/api/submissions`, {
      headers: { authorization: 'Bearer test-upload-token' },
    }).then(r => r.json());
    assert.strictEqual(list.total, 1, 'submissions list should report stored candidates');

    const stored = fs.readFileSync(path.join(submissionsDir, list.files[0].filename), 'utf8');
    assert(!stored.includes('12345678'), 'stored submission should redact password values');
    assert(!stored.includes('sk-test_secret'), 'stored submission should redact API-key-like values');

    const signal = await fetch(`${base}/api/dev-signals`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-upload-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event_id: 'evt_test_1',
        session_id: 'sess_test',
        kind: 'post-tool-failure',
        title: 'hvigor 签名失败',
        excerpt: 'Failed to find signature file apiKey=abcdef1234567890',
        signals: ['hvigor_build_fail'],
        error_codes: [],
        relevant: true,
        tool: { name: 'Bash', exit_code: 1, has_stderr: true },
        search: { total: 1, top: [{ dc_id: 'dc_hm_004', score: 120, match_type: 'exact' }] },
        quality: { score: 0.9, reasons: ['failure_evidence'], candidate_ready: true },
        redaction: { findings: [] },
      }),
    }).then(r => r.json());
    assert.strictEqual(signal.ok, true, 'dev signal endpoint should accept valid hook signals');
    assert.strictEqual(signal.status, 'quarantined', 'server-side redaction should quarantine high-risk dev signals');

    const signalList = await fetch(`${base}/api/dev-signals`, {
      headers: { authorization: 'Bearer test-upload-token' },
    }).then(r => r.json());
    assert.strictEqual(signalList.total, 1, 'dev signal list should report stored signals');
    const storedSignal = fs.readFileSync(path.join(devSignalsDir, signalList.files[0].filename), 'utf8');
    assert(!storedSignal.includes('abcdef1234567890'), 'stored dev signal should redact API-key-like values');
  }, {
    HARMONY_EVO_UPLOAD_TOKEN: 'test-upload-token',
    HARMONY_EVO_SUBMISSIONS_DIR: submissionsDir,
    HARMONY_EVO_DEV_SIGNALS_DIR: devSignalsDir,
  });
  fs.rmSync(submissionsDir, { recursive: true, force: true });
  fs.rmSync(devSignalsDir, { recursive: true, force: true });

  console.log('\n  Functional checks passed\n');
  console.log(`  Cases: ${cases.length}`);
  console.log(`  Eligible for promotion: ${getEligibleCases().length}`);
  console.log(`  Quality issues: ${quality.issueCount}`);
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
