const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SERVER = 'http://localhost:3456';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function findProjectConfig(cwd) {
  const names = ['.harmony-evo-client.json', 'harmony-evo-client.json'];
  for (const name of names) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadConfig(overrides = {}) {
  const cwd = overrides.cwd || process.cwd();
  const homeConfig = path.join(os.homedir(), '.harmony-evo-client', 'config.json');
  const projectConfig = findProjectConfig(cwd);
  const fileConfig = {
    ...readJson(homeConfig),
    ...(projectConfig ? readJson(projectConfig) : {}),
  };

  const serverUrl = overrides.serverUrl ||
    process.env.HARMONY_EVO_SERVER ||
    process.env.HARMONY_EVO_URL ||
    fileConfig.serverUrl ||
    DEFAULT_SERVER;

  return {
    cwd,
    serverUrl: String(serverUrl).replace(/\/+$/, ''),
    token: overrides.token || process.env.HARMONY_EVO_TOKEN || fileConfig.token || '',
    top: Number(overrides.top || process.env.HARMONY_EVO_TOP || fileConfig.top || 3),
    minScore: Number(overrides.minScore || process.env.HARMONY_EVO_MIN_SCORE || fileConfig.minScore || 1),
    timeoutMs: Number(overrides.timeoutMs || process.env.HARMONY_EVO_TIMEOUT_MS || fileConfig.timeoutMs || 4500),
    uploadSignals: String(overrides.uploadSignals ?? process.env.HARMONY_EVO_UPLOAD_SIGNALS ?? fileConfig.uploadSignals ?? 'false') === 'true',
    minSignalQuality: Number(overrides.minSignalQuality || process.env.HARMONY_EVO_MIN_SIGNAL_QUALITY || fileConfig.minSignalQuality || 0.5),
    minCandidateQuality: Number(overrides.minCandidateQuality || process.env.HARMONY_EVO_MIN_CANDIDATE_QUALITY || fileConfig.minCandidateQuality || 0.7),
    autoSubmit: String(overrides.autoSubmit ?? process.env.HARMONY_EVO_AUTO_SUBMIT ?? fileConfig.autoSubmit ?? 'false') === 'true',
    cacheDir: overrides.cacheDir || process.env.HARMONY_EVO_CACHE_DIR || fileConfig.cacheDir || path.join(os.homedir(), '.harmony-evo-client'),
  };
}

function clientBinPath() {
  return path.resolve(__dirname, '..', 'bin', 'harmony-evo-client.js');
}

module.exports = { DEFAULT_SERVER, loadConfig, clientBinPath };
