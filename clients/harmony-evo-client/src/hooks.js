const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { redactText, compactText } = require('./redact');
const { detectSignals, queryFromText } = require('./signals');
const { detectProjectProfile } = require('./profile');
const { searchAssets, status, submitCandidate, uploadDevSignal } = require('./server-api');
const { formatSearchContext, formatStatus } = require('./format');
const { buildEventSignal, saveLocalEvent } = require('./event-signals');

function readStdin() {
  return new Promise(resolve => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    setTimeout(() => resolve(input), 1200).unref();
  });
}

function parseJson(input) {
  try { return input.trim() ? JSON.parse(input) : {}; } catch { return {}; }
}

function textFromMessage(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(part => {
      if (typeof part === 'string') return part;
      return part.text || part.content || '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function extractPromptText(input) {
  return [
    input.prompt,
    input.user_prompt,
    input.text,
    textFromMessage(input.message),
    textFromMessage(input.userMessage),
  ].filter(Boolean).join('\n');
}

function extractToolText(input) {
  const tool = input.tool_name || input.toolName || '';
  const tin = input.tool_input || input.toolInput || {};
  const tout = input.tool_response || input.toolResponse || input.tool_result || input.toolResult || {};
  const parts = [tool];

  for (const key of ['command', 'description', 'file_path', 'path', 'content', 'new_string', 'old_string']) {
    if (tin[key]) parts.push(String(tin[key]));
  }
  if (typeof tout === 'string') {
    parts.push(tout);
  } else if (tout && typeof tout === 'object') {
    for (const key of ['stdout', 'stderr', 'error', 'message', 'content']) {
      if (tout[key]) parts.push(String(tout[key]));
    }
    const exit = tout.exit_code ?? tout.exitCode;
    if (exit && Number(exit) !== 0) parts.push(`error: exit code ${exit}`);
  }
  if (input.error) parts.push(String(input.error));
  if (input.is_error || input.isError) parts.push('error: tool result marked as error');

  return parts.filter(Boolean).join('\n');
}

function claudeOutput(eventName, context) {
  if (!context) return {};
  return {
    suppressOutput: true,
    additionalContext: context,
    additional_context: context,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

async function searchForContext(config, rawText) {
  const redacted = redactText(rawText, { maxLength: 9000 });
  const detection = detectSignals(redacted.text);
  if (!detection.relevant) return { context: '', detection, redaction: redacted.report, redactedText: redacted.text };

  const result = await searchAssets(config, {
    query: queryFromText(redacted.text, detection),
    errorCode: detection.errorCodes[0],
    signal: detection.signals.find(s => s !== 'harmony_error_code'),
    top: config.top,
    minScore: config.minScore,
  });

  return {
    context: formatSearchContext(result, { limit: config.top }),
    detection,
    redaction: redacted.report,
    redactedText: redacted.text,
    result,
  };
}

function submissionPath(config) {
  return path.join(config.cacheDir, 'pending-submissions.jsonl');
}

function savePendingSubmission(config, record) {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.appendFileSync(submissionPath(config), JSON.stringify(record) + '\n', 'utf8');
}

function pendingSignalPath(config) {
  return path.join(config.cacheDir, 'pending-dev-signals.jsonl');
}

function savePendingSignal(config, record) {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.appendFileSync(pendingSignalPath(config), JSON.stringify(record) + '\n', 'utf8');
}

async function analyzeAndMaybeUploadSignal(config, kind, input, rawText, found) {
  const redactedText = found?.redactedText || redactText(rawText, { maxLength: 9000 }).text;
  const detection = found?.detection || detectSignals(redactedText);
  const redaction = found?.redaction || redactText(rawText, { maxLength: 9000 }).report;
  const signal = buildEventSignal({
    kind,
    input,
    config,
    redactedText,
    detection,
    redaction,
    searchResult: found?.result,
  });
  saveLocalEvent(config, signal);

  if (!config.uploadSignals || !signal.relevant || !signal.quality.uploadable || signal.quality.score < config.minSignalQuality) {
    return signal;
  }

  try {
    signal.upload = await uploadDevSignal(config, signal);
  } catch (err) {
    savePendingSignal(config, { at: new Date().toISOString(), error: err.message, signal });
  }
  return signal;
}

async function maybeSubmitCandidate(config, input, rawText, searchResult, eventSignal) {
  if (!config.autoSubmit || !rawText) return null;
  if (!eventSignal?.quality?.candidate_ready || eventSignal.quality.score < config.minCandidateQuality) return null;
  const redacted = redactText(rawText, { maxLength: 6000 });
  const detection = detectSignals(redacted.text);
  if (!detection.relevant) return null;

  const candidate = {
    source: 'harmony_evo_client_hook',
    title: compactText(redacted.text.split('\n').find(Boolean) || 'Client captured HarmonyOS issue', 120),
    problem: compactText(redacted.text, 1600),
    solution: '',
    evidence: [
      `Hook event: ${eventSignal.event_id}`,
      `Quality: ${eventSignal.quality.score} (${eventSignal.quality.reasons.join(', ')})`,
      searchResult?.results?.length ? `Matched ${searchResult.results.length} server asset(s)` : 'No matched asset recorded by hook',
    ].join('\n'),
    signals: detection.signals,
    profile: detectProjectProfile(config.cwd),
    redaction: redacted.report,
    client: {
      kind: 'hook',
      event: input.hook_event_name || input.hookEventName || '',
      cwd_hash: eventSignal.client.cwd_hash,
      event_id: eventSignal.event_id,
      session_id: eventSignal.session_id,
    },
  };

  try {
    return await submitCandidate(config, candidate);
  } catch (err) {
    savePendingSubmission(config, { at: new Date().toISOString(), error: err.message, candidate });
    return null;
  }
}

async function runHook(kind, overrides = {}) {
  const raw = await readStdin();
  const input = parseJson(raw);
  const config = loadConfig({ ...overrides, cwd: input.cwd || input.workspace || overrides.cwd || process.cwd() });

  try {
    if (kind === 'session-start') {
      const stats = await status(config).catch(() => null);
      if (!stats) return {};
      return claudeOutput('SessionStart', `[Harmony_Evo]\n${formatStatus(stats, config)}\nUse Harmony_Evo assets when HarmonyOS build/runtime errors appear.`);
    }

    if (kind === 'user-prompt') {
      const text = extractPromptText(input);
      const found = await searchForContext(config, text);
      await analyzeAndMaybeUploadSignal(config, kind, input, text, found);
      return claudeOutput('UserPromptSubmit', found.context);
    }

    if (kind === 'post-tool' || kind === 'post-tool-failure') {
      const text = extractToolText(input);
      const found = await searchForContext(config, text);
      const signal = await analyzeAndMaybeUploadSignal(config, kind, input, text, found);
      await maybeSubmitCandidate(config, input, text, found.result, signal);
      return claudeOutput(kind === 'post-tool-failure' ? 'PostToolUseFailure' : 'PostToolUse', found.context);
    }

    if (kind === 'stop') {
      return {};
    }

    return {};
  } catch {
    return {};
  }
}

module.exports = {
  runHook,
  readStdin,
  extractPromptText,
  extractToolText,
  searchForContext,
  analyzeAndMaybeUploadSignal,
  maybeSubmitCandidate,
  claudeOutput,
};
