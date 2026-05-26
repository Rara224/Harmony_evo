const { loadConfig } = require('./config');
const { redactText, redactFields, compactText } = require('./redact');
const { detectSignals, queryFromText } = require('./signals');
const { searchAssets, status, submitCandidate, sendFeedback } = require('./server-api');
const { formatMcpSearch, formatStatus } = require('./format');
const { detectProjectProfile } = require('./profile');

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function toolDefinitions() {
  return [
    {
      name: 'harmony_search',
      description: 'Search shared HarmonyOS DebugCase/Gene assets for a local error, log, or natural language problem.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Error message, log excerpt, or natural language query.' },
          top: { type: 'number', description: 'Maximum number of assets to return.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'harmony_status',
      description: 'Check Harmony_Evo asset hub connection and asset counts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'harmony_submit_candidate',
      description: 'Submit a redacted candidate case to the Harmony_Evo server review queue. Use only after user intent to share.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          problem: { type: 'string' },
          solution: { type: 'string' },
          evidence: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'problem'],
      },
    },
    {
      name: 'harmony_feedback',
      description: 'Record whether a Harmony_Evo DebugCase helped solve the current issue.',
      inputSchema: {
        type: 'object',
        properties: {
          dc_id: { type: 'string' },
          worked: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['dc_id', 'worked'],
      },
    },
  ];
}

async function callTool(name, args, config) {
  if (name === 'harmony_status') {
    const stats = await status(config);
    return textResult(formatStatus(stats, config));
  }

  if (name === 'harmony_search') {
    const redacted = redactText(args.query || '', { maxLength: 9000 });
    const detection = detectSignals(redacted.text);
    const result = await searchAssets(config, {
      query: queryFromText(redacted.text, detection),
      errorCode: detection.errorCodes[0],
      signal: detection.signals.find(s => s !== 'harmony_error_code'),
      top: args.top || config.top,
      minScore: config.minScore,
    });
    const prefix = redacted.report.redacted
      ? `Redaction applied: ${redacted.report.findings.map(f => `${f.type}(${f.count})`).join(', ')}\n\n`
      : '';
    return textResult(prefix + formatMcpSearch(result));
  }

  if (name === 'harmony_submit_candidate') {
    const redacted = redactFields({
      title: args.title || 'Untitled Harmony issue',
      problem: args.problem || '',
      solution: args.solution || '',
      evidence: args.evidence || '',
    }, { maxLength: 10000 });
    const detection = detectSignals([
      redacted.fields.title,
      redacted.fields.problem,
      redacted.fields.solution,
      redacted.fields.evidence,
    ].join('\n'));
    const submitted = await submitCandidate(config, {
      source: 'mcp_client',
      title: compactText(redacted.fields.title, 160),
      problem: compactText(redacted.fields.problem, 2000),
      solution: compactText(redacted.fields.solution, 1600),
      evidence: compactText(redacted.fields.evidence, 1200),
      tags: Array.isArray(args.tags) ? args.tags.slice(0, 20) : [],
      signals: detection.signals,
      profile: detectProjectProfile(config.cwd),
      redaction: redacted.report,
      client: { kind: 'mcp', cwd: config.cwd },
    });
    return textResult(`Submitted candidate ${submitted.id || ''} with status ${submitted.status || 'submitted'}.`);
  }

  if (name === 'harmony_feedback') {
    const result = await sendFeedback(config, {
      dc_id: args.dc_id,
      worked: !!args.worked,
      note: args.note || '',
    });
    return textResult(`Feedback recorded for ${args.dc_id}. Worked: ${result.worked}.`);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function createResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function createError(id, err) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: err.message || String(err) },
  };
}

async function handleMessage(msg, config) {
  if (!msg || !msg.method) return null;
  if (msg.method === 'initialize') {
    return createResponse(msg.id, {
      protocolVersion: msg.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'harmony-evo-client', version: '0.1.0' },
    });
  }
  if (msg.method === 'tools/list') {
    return createResponse(msg.id, { tools: toolDefinitions() });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    const result = await callTool(name, args, config);
    return createResponse(msg.id, result);
  }
  if (msg.id) return createResponse(msg.id, {});
  return null;
}

async function runMcp(overrides = {}) {
  const config = loadConfig(overrides);
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      Promise.resolve()
        .then(() => handleMessage(JSON.parse(line), config))
        .then(response => { if (response) writeMessage(response); })
        .catch(err => {
          let id = null;
          try { id = JSON.parse(line).id ?? null; } catch {}
          writeMessage(createError(id, err));
        });
    }
  });
}

module.exports = { runMcp, handleMessage, toolDefinitions, callTool };
