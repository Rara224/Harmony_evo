const { URL, URLSearchParams } = require('url');

async function fetchJson(config, pathname, opts = {}) {
  const url = new URL(pathname, config.serverUrl);
  if (opts.query) {
    url.search = new URLSearchParams(opts.query).toString();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers = { 'accept': 'application/json' };
    if (opts.body) headers['content-type'] = 'application/json';
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.error || data?.message || res.statusText;
      throw new Error(`${res.status} ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function status(config) {
  return fetchJson(config, '/api/stats');
}

async function searchAssets(config, request) {
  const query = {
    q: request.query || '',
    top: String(request.top || config.top || 3),
    min_score: String(request.minScore || config.minScore || 1),
  };
  if (request.errorCode) query.error_code = request.errorCode;
  if (request.signal) query.signal = request.signal;
  return fetchJson(config, '/api/search', { query });
}

async function submitCandidate(config, candidate) {
  return fetchJson(config, '/api/submissions', {
    method: 'POST',
    body: candidate,
  });
}

async function uploadDevSignal(config, signal) {
  return fetchJson(config, '/api/dev-signals', {
    method: 'POST',
    body: signal,
  });
}

async function sendFeedback(config, feedback) {
  if (!feedback.dc_id) throw new Error('feedback.dc_id is required');
  return fetchJson(config, `/api/feedback/${encodeURIComponent(feedback.dc_id)}`, {
    method: 'POST',
    body: {
      worked: !!feedback.worked,
      note: feedback.note || '',
    },
  });
}

module.exports = { fetchJson, status, searchAssets, submitCandidate, uploadDevSignal, sendFeedback };
