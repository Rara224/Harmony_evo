const fs = require('fs');
const { loadConfig } = require('./config');
const { redactText, redactFields } = require('./redact');
const { detectSignals, queryFromText } = require('./signals');
const { searchAssets, status, submitCandidate, sendFeedback } = require('./server-api');
const { formatMcpSearch, formatStatus } = require('./format');
const { runHook } = require('./hooks');
const { runMcp } = require('./mcp');
const { installClaude, installOpenCode } = require('./install');
const { detectProjectProfile } = require('./profile');
const { selfTest } = require('./self-test');

function printHelp() {
  console.log(`
Harmony_Evo Client

Usage:
  harmony-evo-client status
  harmony-evo-client search <error or question>
  harmony-evo-client submit --title <title> --problem <text> [--solution <text>]
  harmony-evo-client feedback <dc_id> --worked|--failed [--note <text>]
  harmony-evo-client hook <session-start|user-prompt|post-tool|post-tool-failure|stop>
  harmony-evo-client mcp
  harmony-evo-client install claude [--global] [--server <url>] [--upload-signals] [--auto-submit]
  harmony-evo-client install opencode [--server <url>] [--upload-signals] [--auto-submit] [--mcp-only]
  harmony-evo-client self-test

Environment:
  HARMONY_EVO_SERVER   default http://localhost:3456
  HARMONY_EVO_TOKEN    optional bearer token
  HARMONY_EVO_TOP      default 3
  HARMONY_EVO_UPLOAD_SIGNALS false by default, uploads hook-level dev signals when true
  HARMONY_EVO_AUTO_SUBMIT false by default, submits high-quality bug candidates when true
`.trim());
}

function valueAfter(args, flag, fallback = '') {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

async function runCli(args) {
  const cmd = args[0] || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'hook') {
    const out = await runHook(args[1] || 'user-prompt');
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (cmd === 'mcp') {
    await runMcp();
    return;
  }

  if (cmd === 'install') {
    const server = valueAfter(args, '--server', process.env.HARMONY_EVO_SERVER || undefined);
    const installOpts = {
      server,
      uploadSignals: args.includes('--upload-signals') ? true : undefined,
      autoSubmit: args.includes('--auto-submit') ? true : undefined,
      hooks: args.includes('--mcp-only') ? false : undefined,
    };
    if (args[1] === 'claude') {
      const result = installClaude({ project: !args.includes('--global'), ...installOpts });
      console.log(`Installed Claude Code hooks: ${result.target}`);
      console.log(`Server: ${result.server}`);
      if (result.uploadSignals) console.log('Dev signal upload: enabled');
      if (result.autoSubmit) console.log('Candidate auto-submit: enabled');
      return;
    }
    if (args[1] === 'opencode') {
      const result = installOpenCode(installOpts);
      console.log(`Installed OpenCode MCP config: ${result.target}`);
      if (result.hookTarget) console.log(`Installed OpenCode hook plugin: ${result.hookTarget}`);
      console.log(`Server: ${result.server}`);
      if (result.uploadSignals) console.log('Dev signal upload: enabled');
      return;
    }
    throw new Error('install target must be claude or opencode');
  }

  if (cmd === 'self-test') {
    await selfTest();
    console.log('Harmony_Evo client self-test passed.');
    return;
  }

  const config = loadConfig();

  if (cmd === 'status') {
    const stats = await status(config);
    console.log(formatStatus(stats, config));
    return;
  }

  if (cmd === 'search') {
    const rawQuery = args.slice(1).join(' ');
    if (!rawQuery) throw new Error('search query is required');
    const redacted = redactText(rawQuery);
    const detection = detectSignals(redacted.text);
    const result = await searchAssets(config, {
      query: queryFromText(redacted.text, detection),
      errorCode: detection.errorCodes[0],
      signal: detection.signals.find(s => s !== 'harmony_error_code'),
      top: config.top,
      minScore: config.minScore,
    });
    console.log(formatMcpSearch(result));
    return;
  }

  if (cmd === 'submit') {
    const title = valueAfter(args, '--title');
    const file = valueAfter(args, '--file');
    const problem = valueAfter(args, '--problem') || (file ? fs.readFileSync(file, 'utf8') : '');
    const solution = valueAfter(args, '--solution');
    if (!title || !problem) throw new Error('--title and --problem are required');
    const redacted = redactFields({ title, problem, solution }, { maxLength: 8000 });
    const detection = detectSignals([redacted.fields.title, redacted.fields.problem, redacted.fields.solution].join('\n'));
    const result = await submitCandidate(config, {
      source: 'cli',
      title: redacted.fields.title,
      problem: redacted.fields.problem,
      solution: redacted.fields.solution,
      signals: detection.signals,
      profile: detectProjectProfile(process.cwd()),
      redaction: redacted.report,
      client: { kind: 'cli', cwd: process.cwd() },
    });
    console.log(`Submitted ${result.id || ''} (${result.status || 'submitted'})`);
    return;
  }

  if (cmd === 'feedback') {
    const dcId = args[1];
    if (!dcId) throw new Error('feedback <dc_id> is required');
    const worked = args.includes('--worked') || args.includes('--success');
    const failed = args.includes('--failed') || args.includes('--not-worked');
    if (!worked && !failed) throw new Error('use --worked or --failed');
    const result = await sendFeedback(config, {
      dc_id: dcId,
      worked,
      note: valueAfter(args, '--note'),
    });
    console.log(`Feedback recorded for ${dcId}: worked=${result.worked}`);
    return;
  }

  printHelp();
}

module.exports = { runCli };
