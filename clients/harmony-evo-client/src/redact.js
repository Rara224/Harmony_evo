const crypto = require('crypto');

const REDACTION_RULES = [
  { type: 'authorization_header', pattern: /\b(authorization\s*[:=]\s*)(bearer\s+)?[a-z0-9._~+/=-]{16,}/gi, replacement: '$1[REDACTED:AUTH]' },
  { type: 'api_key', pattern: /\b(sk|ak|rk|pk|ghp|github_pat|hf)_[a-z0-9_\-]{16,}\b/gi, replacement: '[REDACTED:API_KEY]' },
  { type: 'password', pattern: /\b(password|passwd|pwd|keyStorePassword|storePassword|apiKey|api_key|accessKey|secretKey|token|secret)\s*[:=]\s*["']?[^"'\s,;]{6,}/gi, replacement: '$1=[REDACTED:SECRET]' },
  { type: 'cookie', pattern: /\b(cookie\s*[:=]\s*)[^;\n]{12,}/gi, replacement: '$1[REDACTED:COOKIE]' },
  { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED:EMAIL]' },
  { type: 'phone_cn', pattern: /\b1[3-9]\d{9}\b/g, replacement: '[REDACTED:PHONE]' },
  { type: 'private_ip', pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, replacement: '[REDACTED:PRIVATE_IP]' },
  { type: 'p12_path', pattern: /[\w./~ -]+\.(p12|p7b|cer|csr|keystore)\b/gi, replacement: '[REDACTED:SIGNING_FILE]' },
];

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

function redactText(input, opts = {}) {
  const maxLength = opts.maxLength || 12000;
  let text = String(input || '');
  const findings = [];

  for (const rule of REDACTION_RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (...args) => {
      count += 1;
      const match = args[0];
      return typeof rule.replacement === 'function'
        ? rule.replacement(match)
        : rule.replacement;
    });
    if (count > 0) findings.push({ type: rule.type, count });
  }

  if (text.length > maxLength) {
    findings.push({ type: 'truncated', count: text.length - maxLength });
    text = text.slice(0, maxLength) + '\n[TRUNCATED]';
  }

  return {
    text,
    report: {
      redacted: findings.length > 0,
      findings,
      content_hash: shortHash(text),
    },
  };
}

function compactText(input, max = 1000) {
  return String(input || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function mergeRedactionReports(...reports) {
  const counts = new Map();
  const hashes = [];
  for (const report of reports.filter(Boolean)) {
    for (const finding of report.findings || []) {
      counts.set(finding.type, (counts.get(finding.type) || 0) + Number(finding.count || 0));
    }
    if (report.content_hash) hashes.push(report.content_hash);
  }
  const findings = [...counts.entries()].map(([type, count]) => ({ type, count }));
  return {
    redacted: findings.length > 0,
    findings,
    content_hash: shortHash(hashes.join(':')),
  };
}

function redactFields(fields, opts = {}) {
  const out = {};
  const reports = [];
  for (const [key, value] of Object.entries(fields || {})) {
    const redacted = redactText(value || '', opts);
    out[key] = redacted.text;
    reports.push(redacted.report);
  }
  return { fields: out, report: mergeRedactionReports(...reports) };
}

module.exports = { redactText, redactFields, mergeRedactionReports, compactText, REDACTION_RULES };
