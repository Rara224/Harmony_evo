const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientBinPath, DEFAULT_SERVER } = require('./config');

function quoteShell(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_/:=.,@+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

function readJsonc(filePath) {
  try { return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8'))); } catch { return {}; }
}

function addClaudeHook(settings, event, hook, matcher) {
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = settings.hooks[event] || [];
  const entry = matcher
    ? settings.hooks[event].find(item => item.matcher === matcher)
    : settings.hooks[event].find(item => !item.matcher);
  const target = entry || { ...(matcher ? { matcher } : {}), hooks: [] };
  target.hooks = target.hooks || [];
  if (!target.hooks.some(h => h.command === hook.command)) target.hooks.push(hook);
  if (!entry) settings.hooks[event].push(target);
}

function installClaude(opts = {}) {
  const project = opts.project !== false;
  const target = project
    ? path.join(process.cwd(), '.claude', 'settings.local.json')
    : path.join(os.homedir(), '.claude', 'settings.json');
  const settings = readJson(target);
  const bin = clientBinPath();
  const node = process.execPath;
  const server = opts.server || process.env.HARMONY_EVO_SERVER || DEFAULT_SERVER;

  settings.env = settings.env || {};
  if (opts.server || !settings.env.HARMONY_EVO_SERVER) settings.env.HARMONY_EVO_SERVER = server;
  if (opts.uploadSignals === true) settings.env.HARMONY_EVO_UPLOAD_SIGNALS = 'true';
  if (opts.autoSubmit === true) settings.env.HARMONY_EVO_AUTO_SUBMIT = 'true';

  const cmd = (...args) => `${quoteShell(node)} ${quoteShell(bin)} ${args.map(quoteShell).join(' ')}`;
  addClaudeHook(settings, 'SessionStart', { type: 'command', command: cmd('hook', 'session-start'), timeout: 5 });
  addClaudeHook(settings, 'UserPromptSubmit', { type: 'command', command: cmd('hook', 'user-prompt'), timeout: 5 });
  addClaudeHook(settings, 'PostToolUse', { type: 'command', command: cmd('hook', 'post-tool'), timeout: 5 }, 'Bash|Write|Edit|MultiEdit');
  addClaudeHook(settings, 'PostToolUseFailure', { type: 'command', command: cmd('hook', 'post-tool-failure'), timeout: 5 }, 'Bash|Write|Edit|MultiEdit');
  addClaudeHook(settings, 'Stop', { type: 'command', command: cmd('hook', 'stop'), timeout: 5 });

  writeJson(target, settings);
  return { target, server, uploadSignals: opts.uploadSignals === true, autoSubmit: opts.autoSubmit === true };
}

function installOpenCode(opts = {}) {
  const target = path.join(process.cwd(), 'opencode.jsonc');
  const config = fs.existsSync(target) ? readJsonc(target) : {};
  const server = opts.server || process.env.HARMONY_EVO_SERVER || DEFAULT_SERVER;
  const installHooks = opts.hooks !== false;
  if (!config.$schema) config.$schema = 'https://opencode.ai/config.json';
  config.mcp = config.mcp || {};
  config.mcp['harmony-evo'] = {
    type: 'local',
    command: [process.execPath, clientBinPath(), 'mcp'],
    enabled: true,
    timeout: 7000,
    environment: {
      HARMONY_EVO_SERVER: server,
    },
  };
  if (opts.uploadSignals === true) {
    config.mcp['harmony-evo'].environment.HARMONY_EVO_UPLOAD_SIGNALS = 'true';
  }
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');

  let hookTarget = '';
  if (installHooks) {
    hookTarget = writeOpenCodePlugin({
      server,
      uploadSignals: opts.uploadSignals === true,
      autoSubmit: opts.autoSubmit === true,
    });
  }

  return { target, hookTarget, server, uploadSignals: opts.uploadSignals === true, hooks: installHooks };
}

function writeOpenCodePlugin(opts = {}) {
  const hookTarget = path.join(process.cwd(), '.opencode', 'plugins', 'harmony-evo.js');
  const hooksModule = path.join(__dirname, 'opencode-hooks.js');
  const defaults = {
    serverUrl: opts.server || DEFAULT_SERVER,
    uploadSignals: opts.uploadSignals === true,
    autoSubmit: opts.autoSubmit === true,
  };
  const source = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runOpenCodeEvent,
  getOpenCodeSessionContext,
} = require(${JSON.stringify(hooksModule)});

const defaults = ${JSON.stringify(defaults, null, 2)};

async function safeRun(kind, payload, overrides = {}) {
  try {
    return await runOpenCodeEvent(kind, payload, { ...defaults, ...overrides });
  } catch {
    return { ok: false };
  }
}

export const HarmonyEvoPlugin = async ({ directory, project }) => {
  const base = { directory, project };
  return {
    event: async ({ event }) => {
      const type = String(event?.type || '');
      if (!/(error|failed|idle)/i.test(type)) return;
      await safeRun('event', { ...base, event });
    },
    'chat.message': async (input, output) => {
      await safeRun('chat-message', { ...base, input, output });
    },
    'command.execute.before': async (input, output) => {
      await safeRun('command-before', { ...base, input, output });
    },
    'tool.execute.before': async (input, output) => {
      await safeRun('tool-before', { ...base, input, output });
    },
    'tool.execute.after': async (input, output) => {
      await safeRun('tool-after', { ...base, input, output });
    },
    'experimental.chat.system.transform': async (input, output) => {
      const context = getOpenCodeSessionContext(input.sessionID);
      if (context) output.system.push(context);
    },
  };
};
`;
  fs.mkdirSync(path.dirname(hookTarget), { recursive: true });
  fs.writeFileSync(hookTarget, source, 'utf8');
  return hookTarget;
}

module.exports = { installClaude, installOpenCode, writeOpenCodePlugin, quoteShell, stripJsonComments };
