const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { compactText } = require('./redact');
const { detectProjectProfile } = require('./profile');

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function sessionId(input = {}, cwd = process.cwd()) {
  const explicit = input.session_id || input.sessionId || input.conversation_id || input.conversationId;
  if (explicit) return String(explicit).slice(0, 120);
  const transcript = input.transcript_path || input.transcriptPath || '';
  return `local_${hashText(`${cwd}:${transcript || Date.now()}`)}`;
}

function eventId(kind, input = {}, text = '') {
  const base = [
    kind,
    input.session_id || input.sessionId || '',
    input.tool_name || input.toolName || '',
    input.hook_event_name || input.hookEventName || '',
    text.slice(0, 400),
    Date.now(),
  ].join(':');
  return `evt_${hashText(base)}`;
}

function getTool(input = {}) {
  const toolInput = input.tool_input || input.toolInput || {};
  const toolOutput = input.tool_response || input.toolResponse || input.tool_result || input.toolResult || {};
  const metadata = typeof toolOutput === 'object' && toolOutput ? toolOutput.metadata || {} : {};
  const topLevelError = input.error || input.message || '';
  const parsedExit = String(topLevelError || '').match(/\bExit code\s+(\d+)\b/i)?.[1];
  const exitCode = toolOutput?.exit_code ?? toolOutput?.exitCode ?? toolOutput?.exit ?? metadata.exit_code ?? metadata.exitCode ?? metadata.exit ?? input.exit_code ?? input.exitCode ?? parsedExit;
  const stderr = typeof toolOutput === 'object' && toolOutput ? toolOutput.stderr || toolOutput.error || toolOutput.message || metadata.stderr || topLevelError || '' : topLevelError;
  const stdout = typeof toolOutput === 'object' && toolOutput ? toolOutput.stdout || toolOutput.content || toolOutput.output || metadata.stdout || metadata.output || '' : '';
  const command = toolInput.command || toolInput.description || '';
  const filePath = toolInput.file_path || toolInput.path || '';
  return {
    name: input.tool_name || input.toolName || '',
    command: compactText(command, 300),
    file_path: filePath ? path.basename(String(filePath)) : '',
    exit_code: exitCode === undefined || exitCode === null || exitCode === '' ? null : Number(exitCode),
    has_stderr: !!stderr,
    output_hash: hashText([stdout, stderr].join('\n')),
  };
}

function summarizeMatches(result = {}) {
  const hits = result.results || [];
  return {
    total: result.total ?? hits.length,
    top: hits.slice(0, 3).map(hit => {
      const dc = hit.case || hit;
      return {
        dc_id: dc.dc_id || '',
        title: compactText(dc.title || '', 140),
        match_type: hit.matchType || '',
        score: Number(hit.score || 0),
        error_code: dc.symptom?.error_code || '',
      };
    }),
  };
}

function highRiskRedaction(report = {}) {
  return (report.findings || []).some(f => ['api_key', 'authorization_header', 'password', 'cookie'].includes(f.type));
}

function scoreEvent({ kind, text, detection, tool, search, redaction }) {
  let score = 0;
  const reasons = [];
  const isToolEvent = kind === 'post-tool' || kind === 'post-tool-failure';
  const isFailure = kind === 'post-tool-failure' || (isToolEvent && ((tool.exit_code !== null && tool.exit_code !== 0) || tool.has_stderr));
  const exactMatch = (search.top || []).some(m => m.match_type === 'exact' || m.score >= 100);
  const strongMatch = (search.top || []).some(m => m.score >= 30);
  const toolName = String(tool.name || '').toLowerCase();
  const command = String(tool.command || '').toLowerCase();
  const isHarmonyTool = toolName.includes('harmony-evo');
  const isValidationCommand = toolName === 'bash' && /\b(npm run|hvigor|build|assemble|test|ohpm)\b/.test(command);

  if (detection.relevant) { score += 0.25; reasons.push('harmony_signal'); }
  if (detection.errorCodes.length) { score += 0.15; reasons.push('error_code'); }
  if (detection.signals.length >= 2) { score += 0.05; reasons.push('multiple_signals'); }
  if (isToolEvent) { score += 0.1; reasons.push('tool_event'); }
  if (isFailure) { score += 0.25; reasons.push('failure_evidence'); }
  if (exactMatch) { score += 0.2; reasons.push('exact_case_match'); }
  else if (strongMatch) { score += 0.1; reasons.push('case_signal_match'); }
  if (String(text || '').length >= 80) { score += 0.05; reasons.push('enough_context'); }
  if (highRiskRedaction(redaction)) { score -= 0.2; reasons.push('high_risk_redaction'); }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return {
    score,
    reasons,
    is_failure: isFailure,
    uploadable: detection.relevant && (isFailure || kind === 'user-prompt' || isHarmonyTool || (isValidationCommand && exactMatch) || score >= 0.8),
    candidate_ready: detection.relevant && isFailure && score >= 0.7,
  };
}

function deriveTitle(text, kind, tool) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const diagnostic = /报错|失败|错误|exception|failed|error|hvigor|signing|signature|permission|ability|arkui|crash|oom|卡顿|签名/i;
  const skip = new Set([tool.name, tool.command].filter(Boolean).map(String));
  const useful = lines.filter(line => !skip.has(line) && !/^error:\s*exit code/i.test(line));
  return compactText(useful.find(line => diagnostic.test(line)) || useful[0] || `${kind} HarmonyOS signal`, 160);
}

function buildEventSignal({ kind, input, config, redactedText, detection, redaction, searchResult }) {
  const tool = getTool(input);
  const search = summarizeMatches(searchResult || {});
  const quality = scoreEvent({ kind, text: redactedText, detection, tool, search, redaction });
  const sid = sessionId(input, config.cwd);
  return {
    event_id: eventId(kind, input, redactedText),
    session_id: sid,
    captured_at: new Date().toISOString(),
    source: 'harmony_evo_client_hook',
    hook_event: input.hook_event_name || input.hookEventName || kind,
    kind,
    title: deriveTitle(redactedText, kind, tool),
    excerpt: compactText(redactedText, 2200),
    signals: detection.signals,
    error_codes: detection.errorCodes,
    relevant: detection.relevant,
    tool,
    search,
    quality,
    redaction,
    profile: detectProjectProfile(config.cwd),
    client: {
      kind: 'hook',
      cwd_hash: hashText(config.cwd),
    },
  };
}

function eventLogPath(config, sid) {
  return path.join(config.cacheDir, 'events', `${sid}.jsonl`);
}

function saveLocalEvent(config, signal) {
  const fp = eventLogPath(config, signal.session_id);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(signal) + '\n', 'utf8');
  return fp;
}

module.exports = {
  buildEventSignal,
  saveLocalEvent,
  summarizeMatches,
  scoreEvent,
  deriveTitle,
  highRiskRedaction,
  hashText,
};
