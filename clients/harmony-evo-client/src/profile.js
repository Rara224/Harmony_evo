const fs = require('fs');
const path = require('path');

const PROFILE_FILES = [
  'oh-package.json5',
  'build-profile.json5',
  'hvigorfile.ts',
  'hvigorfile.js',
  'AppScope/app.json5',
  'entry/src/main/module.json5',
];

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readSmallFile(p, max = 8000) {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

function detectProjectProfile(cwd = process.cwd()) {
  const files = PROFILE_FILES.filter(name => exists(path.join(cwd, name)));
  const text = files.map(name => readSmallFile(path.join(cwd, name))).join('\n');
  const apiMatches = [...text.matchAll(/api(?:Version|ReleaseType)?["'\s:]*([0-9]{1,2})/gi)].map(m => m[1]);
  const harmonyMatches = [...text.matchAll(/HarmonyOS\s*([0-9][0-9.]*)/gi)].map(m => m[1]);

  return {
    cwd: path.basename(cwd),
    project_type: files.length ? 'harmonyos' : 'unknown',
    files,
    api_levels: [...new Set(apiMatches)].slice(0, 5),
    harmonyos_versions: [...new Set(harmonyMatches)].slice(0, 5),
  };
}

module.exports = { detectProjectProfile };
