#!/usr/bin/env node
/**
 * dedupe-candidates.js — remove duplicate raw candidate posts by source_url.
 *
 * Keeps the richest record for each source URL, scored by question/answer/reply
 * text length, and rewrites the per-day JSONL files when --write is passed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'debug_cases', 'candidates');

function candidateFiles() {
  if (!fs.existsSync(CANDIDATES_DIR)) return [];
  return fs.readdirSync(CANDIDATES_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('.'))
    .sort();
}

function keyFor(post) {
  return post.source_url || post.id || `${post.title || ''}:${(post.question || '').slice(0, 80)}`;
}

function score(post) {
  return (post.answer || '').length +
    Math.floor((post.question || '').length / 2) +
    ((post.allReplies || []).join('\n')).length;
}

function readRecords() {
  const records = [];
  for (const file of candidateFiles()) {
    const fp = path.join(CANDIDATES_DIR, file);
    const raw = fs.readFileSync(fp, 'utf8').trim();
    if (!raw) continue;
    raw.split('\n').forEach((line, lineIndex) => {
      try {
        const post = JSON.parse(line);
        records.push({ file, lineIndex, post, key: keyFor(post), score: score(post) });
      } catch {}
    });
  }
  return records;
}

function dedupeCandidates(opts = {}) {
  const records = readRecords();
  const best = new Map();

  for (const record of records) {
    const current = best.get(record.key);
    if (!current || record.score > current.score) best.set(record.key, record);
  }

  const keep = new Set([...best.values()].map(r => `${r.file}:${r.lineIndex}`));
  const byFile = new Map();
  for (const record of records) {
    if (!keep.has(`${record.file}:${record.lineIndex}`)) continue;
    if (!byFile.has(record.file)) byFile.set(record.file, []);
    byFile.get(record.file).push(record.post);
  }

  if (opts.write) {
    for (const file of candidateFiles()) {
      const posts = byFile.get(file) || [];
      const fp = path.join(CANDIDATES_DIR, file);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, posts.map(p => JSON.stringify(p)).join('\n') + (posts.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, fp);
    }
  }

  return {
    before: records.length,
    after: best.size,
    duplicates: records.length - best.size,
    files: candidateFiles().length,
    written: !!opts.write,
  };
}

function main() {
  const write = process.argv.includes('--write');
  const result = dedupeCandidates({ write });
  console.log(`\n  Candidate dedupe: ${result.duplicates} duplicate(s)`);
  console.log(`  Records: ${result.before} -> ${result.after}`);
  console.log(`  Files:   ${result.files}`);
  console.log(`  ${write ? 'Wrote changes' : 'Dry run only'}\n`);
}

if (require.main === module) main();

module.exports = { dedupeCandidates };
