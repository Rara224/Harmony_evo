const { loadConfig } = require('./config');
const { searchForContext, analyzeAndMaybeUploadSignal, maybeSubmitCandidate } = require('./hooks');

const sessionContexts = new Map();

function compactJson(value, max = 6000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
  } catch {
    return String(value || '');
  }
}

function textFromPart(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.output === 'string') return part.output;
  if (Array.isArray(part.parts)) return part.parts.map(textFromPart).filter(Boolean).join('\n');
  return '';
}

function textFromParts(parts) {
  return Array.isArray(parts) ? parts.map(textFromPart).filter(Boolean).join('\n') : '';
}

function isFailureText(text) {
  return /\b(error|failed|failure|exception|exit code|non-zero|denied|not found|cannot|unable)\b|失败|报错|异常|找不到|无法|拒绝/i.test(text || '');
}

function explicitToolFailure(input = {}, output = {}) {
  const metadata = output.metadata || {};
  const status = String(output.status || metadata.status || '').toLowerCase();
  const exit = output.exit ?? output.exitCode ?? output.exit_code ?? metadata.exit ?? metadata.exitCode ?? metadata.exit_code;
  if (exit !== undefined && exit !== null && exit !== '') {
    const n = Number(exit);
    if (!Number.isNaN(n)) return n !== 0;
  }
  if (status === 'error' || status === 'failed' || status === 'failure') return true;
  if (output.error) return true;

  // Some shell integrations only expose text, but most OpenCode tools report
  // explicit status/exit metadata. Limit text fallback to command execution so
  // reading source that contains words like "Failed" does not become a failure.
  const toolName = String(input.tool || input.tool_name || input.toolName || '').toLowerCase();
  return toolName === 'bash' && isFailureText([
    output.title || '',
    output.output || '',
    metadata.output || '',
  ].filter(Boolean).join('\n'));
}

function normalizeEvent(kind, payload = {}) {
  const input = payload.input || {};
  const output = payload.output || {};
  const event = payload.event || {};

  if (kind === 'chat-message') {
    return {
      hookKind: 'user-prompt',
      text: [
        input.agent ? `agent: ${input.agent}` : '',
        input.model ? `model: ${compactJson(input.model, 600)}` : '',
        textFromParts(output.parts),
        output.message ? compactJson(output.message, 2500) : '',
      ].filter(Boolean).join('\n'),
    };
  }

  if (kind === 'tool-before') {
    return {
      hookKind: 'post-tool',
      text: [
        `tool: ${input.tool || ''}`,
        `args:\n${compactJson(output.args || input.args || {}, 6000)}`,
      ].join('\n'),
    };
  }

  if (kind === 'tool-after') {
    const text = [
      `tool: ${input.tool || ''}`,
      `args:\n${compactJson(input.args || {}, 4000)}`,
      output.title ? `title: ${output.title}` : '',
      output.output ? `output:\n${String(output.output)}` : '',
      output.metadata ? `metadata:\n${compactJson(output.metadata, 2500)}` : '',
    ].filter(Boolean).join('\n');
    return {
      hookKind: explicitToolFailure(input, output) ? 'post-tool-failure' : 'post-tool',
      text,
    };
  }

  if (kind === 'command-before') {
    return {
      hookKind: 'user-prompt',
      text: [
        `command: ${input.command || ''}`,
        input.arguments ? `arguments: ${input.arguments}` : '',
        textFromParts(output.parts),
      ].filter(Boolean).join('\n'),
    };
  }

  if (kind === 'event') {
    return {
      hookKind: isFailureText(compactJson(event, 3000)) ? 'post-tool-failure' : 'post-tool',
      text: compactJson(event, 3000),
    };
  }

  return { hookKind: 'post-tool', text: compactJson(payload, 3000) };
}

async function runOpenCodeEvent(kind, payload = {}, overrides = {}) {
  const directory = payload.directory || overrides.cwd || process.cwd();
  const input = payload.input || {};
  const sessionID = input.sessionID || payload.sessionID || payload.event?.properties?.sessionID || '';
  const config = loadConfig({ ...overrides, cwd: directory });
  const normalized = normalizeEvent(kind, payload);

  if (!normalized.text.trim()) return { ok: true, relevant: false };

  const found = await searchForContext(config, normalized.text);
  if (found.context && sessionID) {
    sessionContexts.set(sessionID, {
      context: found.context,
      updatedAt: Date.now(),
    });
  }

  const signalInput = {
    ...input,
    hook_event_name: `opencode:${kind}`,
    hookEventName: `opencode:${kind}`,
    session_id: sessionID || input.session_id,
    tool_name: input.tool || input.tool_name,
    tool_input: input.args,
    tool_response: payload.output,
    cwd: directory,
  };
  const signal = await analyzeAndMaybeUploadSignal(config, normalized.hookKind, signalInput, normalized.text, found);
  if (kind === 'tool-after') {
    await maybeSubmitCandidate(config, signalInput, normalized.text, found.result, signal);
  }

  return {
    ok: true,
    relevant: !!signal.relevant,
    quality: signal.quality,
    matched: found.result?.results?.length || 0,
  };
}

function getOpenCodeSessionContext(sessionID) {
  if (!sessionID) return '';
  const item = sessionContexts.get(sessionID);
  if (!item) return '';
  if (Date.now() - item.updatedAt > 10 * 60 * 1000) {
    sessionContexts.delete(sessionID);
    return '';
  }
  return item.context || '';
}

module.exports = {
  runOpenCodeEvent,
  getOpenCodeSessionContext,
  normalizeEvent,
  textFromParts,
};
