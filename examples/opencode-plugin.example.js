import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runOpenCodeEvent,
  getOpenCodeSessionContext,
} = require('/absolute/path/to/harmony-evo-client-standalone/src/opencode-hooks.js');

const defaults = {
  serverUrl: 'http://SERVER_IP:3456',
  uploadSignals: false,
  autoSubmit: false,
};

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
