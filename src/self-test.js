const assert = require('assert');
const { redactText, redactFields } = require('./redact');
const { detectSignals } = require('./signals');
const { handleMessage } = require('./mcp');
const { loadConfig } = require('./config');
const { buildEventSignal } = require('./event-signals');
const { normalizeEvent } = require('./opencode-hooks');
const { installOpenCode } = require('./install');
const { extractToolText } = require('./hooks');

async function selfTest() {
  const redacted = redactText('Authorization: Bearer sk-test_secret_1234567890 password=12345678');
  assert(redacted.report.redacted, 'redaction should detect secrets');
  assert(!redacted.text.includes('12345678'), 'password should be redacted');
  const fields = redactFields({
    problem: 'apiKey=abcdef1234567890',
    solution: 'Authorization: Bearer sk-test_secret_1234567890',
  });
  assert(fields.report.redacted, 'field redaction should detect secrets');
  assert(!fields.fields.problem.includes('abcdef1234567890'), 'problem field should be redacted');
  assert(!fields.fields.solution.includes('sk-test_secret'), 'solution field should be redacted');

  const detected = detectSignals('HarmonyOS requestPermissionsFromUser 权限弹窗不显示 907135702');
  assert(detected.relevant, 'HarmonyOS text should be relevant');
  assert(detected.errorCodes.includes('907135702'), 'error code should be extracted');

  const signal = buildEventSignal({
    kind: 'post-tool-failure',
    input: { session_id: 's1', tool_name: 'Bash', tool_result: { stderr: 'Failed to find signature file', exit_code: 1 } },
    config: loadConfig({ cwd: process.cwd() }),
    redactedText: 'hvigor Failed to find signature file build-profile.json5 signingConfigs',
    detection: detectSignals('hvigor Failed to find signature file build-profile.json5 signingConfigs'),
    redaction: { findings: [] },
    searchResult: { results: [{ matchType: 'exact', score: 120, case: { dc_id: 'dc_hm_004', title: 'Hvigor 编译报错' } }] },
  });
  assert(signal.quality.candidate_ready, 'failed hook event with exact match should be candidate ready');
  assert(signal.title.includes('Failed to find signature file'), 'event title should prefer diagnostic lines');
  assert.strictEqual(signal.client.cwd_hash.length, 16, 'event should store cwd hash instead of raw cwd');

  const claudeFailureInput = {
    session_id: 's2',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm run build 2>&1' },
    error: 'Exit code 1\nERROR: Failed to find signature file.\nsigningConfigs.default.material.keyStorePath points to ./sign/missing-release.p12',
  };
  const claudeFailureText = extractToolText(claudeFailureInput);
  assert(claudeFailureText.includes('Failed to find signature file'), 'Claude top-level hook error should be captured');
  const claudeFailureSignal = buildEventSignal({
    kind: 'post-tool-failure',
    input: claudeFailureInput,
    config: loadConfig({ cwd: process.cwd() }),
    redactedText: claudeFailureText,
    detection: detectSignals(claudeFailureText),
    redaction: { findings: [] },
    searchResult: { results: [{ matchType: 'exact', score: 120, case: { dc_id: 'dc_hm_004', title: 'Hvigor 编译报错' } }] },
  });
  assert.strictEqual(claudeFailureSignal.tool.exit_code, 1, 'Claude top-level Exit code should be parsed');
  assert(claudeFailureSignal.quality.candidate_ready, 'Claude failure hook should become candidate ready');

  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, loadConfig({ timeoutMs: 10 }));
  assert.strictEqual(init.result.serverInfo.name, 'harmony-evo-client');

  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, loadConfig({ timeoutMs: 10 }));
  assert(list.result.tools.some(t => t.name === 'harmony_search'), 'MCP tools should include harmony_search');

  const opencodeTool = normalizeEvent('tool-after', {
    input: { tool: 'bash', args: { command: 'hvigor build' } },
    output: { title: 'failed', output: 'Failed to find signature file' },
  });
  assert.strictEqual(opencodeTool.hookKind, 'post-tool-failure', 'OpenCode failed tools should map to failure hooks');
  assert(opencodeTool.text.includes('signature file'), 'OpenCode tool text should keep diagnostic output');

  const cwd = process.cwd();
  const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'harmony-evo-client-'));
  process.chdir(tmp);
  try {
    const installed = installOpenCode({ server: 'http://127.0.0.1:3456', uploadSignals: true });
    assert(require('fs').existsSync(installed.target), 'OpenCode MCP config should be written');
    assert(require('fs').existsSync(installed.hookTarget), 'OpenCode plugin should be written');
    const plugin = require('fs').readFileSync(installed.hookTarget, 'utf8');
    assert(plugin.includes('tool.execute.after'), 'OpenCode plugin should listen for tool execution');
    assert(plugin.includes('experimental.chat.system.transform'), 'OpenCode plugin should inject matched context');
  } finally {
    process.chdir(cwd);
    require('fs').rmSync(tmp, { recursive: true, force: true });
  }

  return true;
}

module.exports = { selfTest };
