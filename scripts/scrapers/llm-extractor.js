#!/usr/bin/env node
/**
 * llm-extractor.js — LLM-powered structured extraction from raw forum posts
 *
 * Takes raw scraped posts (JSONL) and converts them to structured DebugCases
 * using Claude API (or compatible LLM). Extracts:
 *   - symptom (error signals, error message, scenario)
 *   - root cause (category, analysis)
 *   - fix (strategy, description, code snippet)
 *   - tags (OS version, API category, bug type, severity, keywords)
 *
 * Usage:
 *   node scripts/scrapers/llm-extractor.js                           # process all candidates
 *   node scripts/scrapers/llm-extractor.js --file <path>             # process one file
 *   node scripts/scrapers/llm-extractor.js --post-id hm_raw_xxx      # process one post
 *   node scripts/scrapers/llm-extractor.js --dry-run                 # show what would be processed
 *   node scripts/scrapers/llm-extractor.js --manual                  # manual edit mode (template only)
 */

const fs = require('fs');
const path = require('path');
const { validateCase, generateId, storeCase, saveCandidate } = require('../debug-case/schema');

const ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'debug_cases', 'candidates');
const PROCESSED_FILE = path.join(CANDIDATES_DIR, '.processed.json');

// ─── LLM extraction prompt ───────────────────────────────────────────────

const EXTRACTION_PROMPT = `你是一个 HarmonyOS 开发专家。请从以下华为开发者论坛的帖子中，提取结构化 DebugCase 信息。

帖子标题：{title}
问题描述：{question}
最佳回答：{answer}
标签：{tags}

请提取以下 JSON 字段（只输出 JSON，不要其他文字）：

{
  "title": "简短的问题标题",
  "symptom": {
    "error_signals": ["错误信号标签（英文小写，用下划线连接，如：push_token_null, api_timeout, permission_denied）"],
    "error_code": "如果有华为错误码，如 907135702；没有则留空字符串",
    "error_message": "原始错误信息或日志片段",
    "observed_environment": ["HarmonyOS 版本", "设备型号", "API 级别"],
    "scenario": "用户在什么场景下遇到此问题（一句话）"
  },
  "root_cause": {
    "category": "根因类别，可选值：api_usage, permission, ui_ux, performance, build_compile, device_compat, network, data_storage, security, third_party, configuration, other",
    "analysis": "根因分析（中文，100-200字）",
    "related_api": "相关 HarmonyOS API 或组件名",
    "confidence": 0.9
  },
  "fix": {
    "strategy": "修复策略，可选值：repair, optimize, workaround, config_change, upgrade",
    "description": "修复步骤描述（中文，100-200字）",
    "diff_summary": "代码变更摘要",
    "key_code_snippet": "关键修复代码片段",
    "validation": "验证方法",
    "api_level": "适用 API 级别"
  },
  "tags": {
    "harmonyos_version": ["相关版本号"],
    "api_category": ["API分类，如：push, ability, hms-core, arkui, etc."],
    "bug_type": ["bug类型，如：null_return, crash, async_timing, permission, layout, memory_leak"],
    "severity": "严重程度：critical, major, minor, cosmetic 之一",
    "keywords": ["搜索关键词，5-10个，中英文混合"]
  }
}

注意：
1. 如果帖子中没有足够信息，相应字段填 null 或空数组
2. error_signals 必须是英文小写，用下划线连接的标签
3. category 必须从可选值列表中选取
4. severity 必须是 critical/major/minor/cosmetic 之一
5. 关键词要包含中文和英文，便于搜索
6. 置信度低于 0.7 时，请在 analysis 中注明不确定之处`;

// ─── Template-based extraction (fallback when no LLM API) ─────────────────

function templateExtract(rawPost) {
  const title = rawPost.title || '';
  const question = rawPost.question || '';
  const answer = rawPost.answer || '';
  const tags = rawPost.tags || [];

  // ── Clean forum noise from answer ──────────────────────────────────
  const cleanAnswer = cleanForumText(answer);
  const cleanQuestion = cleanForumText(question);

  // ── Detect HarmonyOS error codes ───────────────────────────────────
  const allText = question + answer;
  const errorCodes = allText.match(/\b(\d{6,9})\b/g) || [];
  const errorCode = errorCodes.length > 0 ? errorCodes[0] : '';

  // ── Detect common patterns with richer signal set ──────────────────
  const patterns = [
    { regex: /权限|permission|授权/, signal: 'permission_issue' },
    { regex: /闪退|崩溃|crash|异常退出|闪屏/, signal: 'app_crash' },
    { regex: /\bnull\b|null pointer|空指针/, signal: 'null_value' },
    { regex: /超时|timeout|timed out/i, signal: 'api_timeout' },
    { regex: /卡顿|掉帧|不跟手|帧率|jank|lag|性能/i, signal: 'performance_issue' },
    { regex: /OOM|内存溢出|OutOfMemory|内存不足/i, signal: 'memory_issue' },
    { regex: /编译失败|build fail|Hvigor.*错误|打包失败|签名.*文件|signature file/i, signal: 'build_error' },
    { regex: /网络请求|连接失败|网络不通|ERR_CLEARTEXT/, signal: 'network_error' },
    { regex: /路由|router\.push|router\.replace|页面栈|navigation/i, signal: 'navigation_error' },
    { regex: /canvas|Canvas|画布/, signal: 'canvas_issue' },
    { regex: /组件|component|UI|布局|layout|界面/, signal: 'ui_issue' },
    { regex: /天气|weather|气压|barometer|sensor\.|传感器/, signal: 'sensor_data' },
    { regex: /API\s*(level|级别|版本)/i, signal: 'api_version' },
    { regex: /设备兼容|device.*compat|机型.*不适配/i, signal: 'device_compat' },
    { regex: /下载|安装|download|install/i, signal: 'setup_issue' },
    { regex: /元服务|部署|上线|政策/, signal: 'deployment_query' },
  ];

  const errorSignals = [];
  if (errorCode) errorSignals.push(`err_${errorCode}`);
  for (const p of patterns) {
    if (p.regex.test(allText)) errorSignals.push(p.signal);
  }
  if (errorSignals.length === 0) errorSignals.push('general_query');

  // ── Detect root cause category ─────────────────────────────────────
  const category = detectCategory(allText);

  // ── Extract code snippets from answer ──────────────────────────────
  const codeSnippet = extractCodeBlock(answer);

  // ── Detect HarmonyOS version ───────────────────────────────────────
  const versions = [];
  const verMatch = allText.match(/API\s*(\d{1,2})/g) || [];
  for (const v of verMatch) {
    const num = v.match(/\d+/)[0];
    if (num && !versions.includes(num)) versions.push(num);
  }
  const harmonyVerMatch = allText.match(/HarmonyOS\s*(\d[\d.]*)/i);
  if (harmonyVerMatch && !versions.includes(harmonyVerMatch[1])) {
    versions.push(harmonyVerMatch[1]);
  }

  // ── Detect severity ────────────────────────────────────────────────
  const severity = /闪退|崩溃|crash|OOM|内存溢出/i.test(allText) ? 'critical' :
                   /编译|build|打包|签名|权限|permission/i.test(allText) ? 'major' :
                   /卡顿|性能|超时/i.test(allText) ? 'major' : 'minor';

  // ── Extract API categories from known vocabulary ───────────────────
  const apiCategories = extractApiCategories(allText, tags);

  // ── Build clean keywords ───────────────────────────────────────────
  const keywords = buildKeywords(title, cleanQuestion, tags, errorCode);

  return {
    title,
    symptom: {
      error_signals: errorSignals,
      error_code: errorCode,
      error_message: cleanQuestion.slice(0, 500),
      observed_environment: versions.length > 0 ? [`HarmonyOS ${versions[0]}`] : [],
      scenario: title.slice(0, 200),
    },
    root_cause: {
      category,
      analysis: cleanQuestion.slice(0, 300) || `问题：${title}`,
      related_api: detectRelatedApi(allText),
      confidence: 0.6, // Template extraction: better than random, not as good as LLM
    },
    fix: {
      strategy: detectStrategy(allText),
      description: cleanAnswer.slice(0, 800) || '请参考帖子原文',
      diff_summary: '',
      key_code_snippet: codeSnippet.slice(0, 1000),
      validation: '需要人工验证',
      api_level: versions.length > 0 ? `API ${versions[0]}` : '',
    },
    tags: {
      harmonyos_version: versions,
      api_category: apiCategories,
      bug_type: errorSignals.filter(s => !s.startsWith('err_')).slice(0, 4),
      severity,
      keywords,
    },
  };
}

// ── Extraction helpers ──────────────────────────────────────────────────

const KNOWN_APIS = {
  'push': ['push', '推送', 'hms.core.push', 'token'],
  'ability': ['ability', 'startAbility', 'AbilityStage'],
  'hms-core': ['hms', 'hms core', 'hms service'],
  'arkui': ['arkui', '组件', 'component', 'list', 'UI', '界面', 'canvas', '画布', 'clock', '时钟', 'shadow', '阴影', '导航', 'span'],
  'permission': ['权限', 'permission', 'requestPermissionsFromUser'],
  'hvigor': ['hvigor', '编译', 'build', '打包', '签名'],
  'network': ['网络', 'network', 'http', 'https', 'request'],
  'router': ['路由', 'router', '页面跳转', 'navigation'],
  'image': ['图片', 'image', 'pixelmap', 'bitmap'],
  'sensor': ['传感器', 'sensor', '气压', '海拔', '天气'],
  'router': ['路由', 'router', 'replace', 'push'],
};

function extractApiCategories(text, forumTags) {
  const found = new Set();
  const lower = text.toLowerCase();

  // Analyze the actual question/answer text, not forum chrome
  for (const [api, keywords] of Object.entries(KNOWN_APIS)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        found.add(api);
        break;
      }
    }
  }

  // Forum tags are unreliable (page layout categories, not question tags)
  // Only use them as hints, not primary signal
  for (const t of forumTags) {
    const clean = t.replace(/^[|｜\s]+/, '').trim();
    // Filter obvious noise: tags with pipe prefix, version markers, or too generic
    if (!clean || clean.length < 3 || clean.length > 20) continue;
    if (/版|新|采纳|回复|来自|\d/.test(clean)) continue;
    // Try to match against known APIs
    const lc = clean.toLowerCase();
    for (const [api, keywords] of Object.entries(KNOWN_APIS)) {
      for (const kw of keywords) {
        if (lc.includes(kw.toLowerCase())) {
          found.add(api);
          break;
        }
      }
    }
  }
  return [...found];
}

function cleanForumText(text) {
  if (!text) return '';
  return text
    // Remove forum UI noise lines
    .replace(/\d+楼回复于.*?(来自\s*\S+)?/g, '')
    .replace(/\d+楼编辑于.*?(来自\s*\S+)?/g, '')
    .replace(/展开剩余\d+条回复/g, '')
    // Remove username + pipe + 采纳答复 pattern
    .replace(/^[^\n]{1,30}\n\|\n采纳答复\n?/gm, '')
    .replace(/采纳答复\n?/g, '')
    .replace(/回复\S+/g, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/\S+\s*\|\s*$/gm, '')  // Lines ending with just "|"
    .replace(/\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}.*?(来自\s*\S+)?/g, '')
    // Normalize whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractCodeBlock(text) {
  if (!text) return '';
  // Try to find code in backticks
  const tripleMatch = text.match(/```[\s\S]*?```/);
  if (tripleMatch) return tripleMatch[0].replace(/```\w*\n?/g, '').trim();

  // Try code-like patterns
  const codePatterns = [
    /(?:关键代码|核心代码|示例代码|demo|code|实现|做法)[：:]*\s*([\s\S]{50,500}?)(?:\n\n|\n(?:如果|注意|以上|这样|通过|参考|文档|链接|回复|采纳|$))/i,
  ];
  for (const pat of codePatterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }

  // Look for lines that look like code (contain brackets, semicolons, keywords)
  const lines = text.split('\n');
  const codeLines = lines.filter(l =>
    /[{}().;=<>]/.test(l) &&
    !/^(回复|采纳|来自|编辑|展开)/.test(l) &&
    !/^\d{4}-\d{2}-\d{2}/.test(l) &&
    !/^\d+楼/.test(l)
  );
  if (codeLines.length >= 3) return codeLines.join('\n');

  return '';
}

function detectCategory(text) {
  // Strip URLs first to avoid false matches (e.g. https:// → network)
  const stripped = text.replace(/https?:\/\/\S+/g, '');
  const lower = stripped.toLowerCase();
  if (/权限|permission|授权/.test(lower)) return 'permission';
  if (/传感器|sensor|天气|weather|气压|barometer|海拔/.test(lower)) return 'api_usage';
  if (/编译失败|build fail|hvigor.*错误|打包失败|签名.*找不到|signature file/.test(lower)) return 'build_compile';
  if (/闪退|崩溃|crash|异常.*闪退/.test(lower)) return 'api_usage';
  if (/卡顿|掉帧|性能|帧率|jank|lag|不跟手|性能/.test(lower)) return 'performance';
  if (/OOM|内存溢出|memory/i.test(lower)) return 'performance';
  if (/ERR_CLEARTEXT|网络请求失败|连接失败|network.*error/.test(lower)) return 'network';
  if (/路由|router\.push|页面栈|navigation/.test(lower)) return 'api_usage';
  if (/config\.json|module\.json5|配置.*签名|权限声明/.test(lower)) return 'configuration';
  if (/canvas|画布|clock|时钟|shadow|阴影|HdsTabs/.test(lower)) return 'ui_ux';
  if (/设备兼容|device.*compat|机型.*不适配/.test(lower)) return 'device_compat';
  if (/元服务|部署|上线|政策/.test(lower)) return 'configuration';
  return 'other';
}

function detectStrategy(text) {
  const lower = text.toLowerCase();
  if (/替换|改为|改用|使用.*代替|ForEach.*LazyForEach|push.*replace/.test(lower)) return 'optimize';
  if (/配置|config|module\.json5|添加.*字段|声明|注册|申请/.test(lower)) return 'config_change';
  if (/升级|更新版本|update|upgrade/.test(lower)) return 'upgrade';
  if (/workaround|临时|绕过|替代方案|暂不/.test(lower)) return 'workaround';
  return 'repair';
}

function detectRelatedApi(text) {
  const apiPatterns = [
    /@[\w.]+\.[\w.]+/g,
    /(?:PushService|requestPermissionsFromUser|startAbility|LazyForEach|ForEach|CanvasRenderingContext2D|createImagePacker|weather\s*kitt|sensor\.\w+|HdsTabs|shadow\b|Span)/g,
  ];
  for (const pat of apiPatterns) {
    const m = text.match(pat);
    if (m) return m[0];
  }
  return '';
}

function buildKeywords(title, cleanQuestion, forumTags, errorCode) {
  const kw = new Set();

  // From title: meaningful words (filter out stop words)
  const stopWords = /^(的|了|在|是|有|和|就|都|也|还|这|那|吗|呢|吧|啊|哦|嗯|怎么|如何|什么|为什么|可以|需要|应该|目前|已经|或者|并且|如果|因为|所以|但是|不过|虽然|然后|还有|一个|一下|一些|这个|那个|比如|例如|等等|最好|相关|请问|请教|帮忙|有没有|是否|不能|不会|不要)$/;
  const titleWords = title.split(/[\s,，、/｜|：:]+/)
    .filter(w => w.length >= 1 && w.length < 15 && !/^\d+$/.test(w) && !stopWords.test(w));
  for (const w of titleWords.slice(0, 6)) kw.add(w);

  // Fallback: if no keywords collected, add the title itself as a keyword
  if (kw.size === 0 && title.length < 30) kw.add(title);

  // Error code
  if (errorCode) kw.add(errorCode);

  // From clean tags - filter out garbage
  for (const t of forumTags) {
    const c = t.replace(/^[|｜\s]+/, '').trim();
    if (c.length >= 2 && c.length < 25 &&
        !/版|新|采纳|回复|来自/.test(c) &&
        !/^\d+$/.test(c)) {
      kw.add(c);
    }
  }

  // Extract quoted API/component names from question
  const apiMatches = cleanQuestion.match(/`([^`]+)`/g) || [];
  for (const m of apiMatches) {
    kw.add(m.replace(/`/g, ''));
  }

  return [...kw].slice(0, 12);
}

// ─── LLM API extraction (when API key is configured) ─────────────────────

async function llmExtract(rawPost, apiKey) {
  const prompt = EXTRACTION_PROMPT
    .replace('{title}', rawPost.title || '')
    .replace('{question}', (rawPost.question || '').slice(0, 4000))
    .replace('{answer}', (rawPost.answer || '').slice(0, 2000))
    .replace('{tags}', JSON.stringify(rawPost.tags || []));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in LLM response');

    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`LLM extraction failed: ${e.message}`);
  }
}

// ─── Processing pipeline ─────────────────────────────────────────────────

async function processRawPost(rawPost, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;

  let extracted;
  if (apiKey && !opts.template) {
    try {
      extracted = await llmExtract(rawPost, apiKey);
    } catch (e) {
      console.error(`  LLM extraction failed, falling back to template: ${e.message}`);
      extracted = templateExtract(rawPost);
    }
  } else {
    extracted = templateExtract(rawPost);
  }

  // Build DebugCase
  const dc = {
    dc_id: generateId('hm'),
    source: 'huawei_forum',
    source_url: rawPost.source_url || '',
    title: extracted.title || rawPost.title,
    symptom: {
      error_signals: extracted.symptom?.error_signals || ['unknown'],
      error_code: extracted.symptom?.error_code || '',
      error_message: extracted.symptom?.error_message || rawPost.question?.slice(0, 500) || '',
      observed_environment: extracted.symptom?.observed_environment || [],
      scenario: extracted.symptom?.scenario || extracted.title || rawPost.title,
    },
    root_cause: {
      category: extracted.root_cause?.category || 'other',
      analysis: extracted.root_cause?.analysis || '需人工分析',
      related_api: extracted.root_cause?.related_api || '',
      confidence: extracted.root_cause?.confidence || 0.5,
    },
    fix: {
      strategy: extracted.fix?.strategy || 'repair',
      description: extracted.fix?.description || (rawPost.answer ? rawPost.answer.slice(0, 500) : '需人工确认修复方案'),
      diff_summary: extracted.fix?.diff_summary || '',
      key_code_snippet: extracted.fix?.key_code_snippet || '',
      validation: extracted.fix?.validation || '需人工验证',
      api_level: extracted.fix?.api_level || '',
    },
    tags: {
      harmonyos_version: extracted.tags?.harmonyos_version || [],
      api_category: extracted.tags?.api_category || [],
      bug_type: extracted.tags?.bug_type || ['other'],
      severity: extracted.tags?.severity || 'major',
      keywords: extracted.tags?.keywords || [...new Set(rawPost.tags || [])],
    },
    evolver_meta: {
      promoted_to_gene: false,
      matched_count: 0,
      related_genes: [],
      ingested_at: new Date().toISOString(),
    },
  };

  // Validate
  const errors = validateCase(dc);
  if (errors.length > 0) {
    return { ok: false, errors, dc };
  }

  return { ok: true, errors: [], dc };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function listCandidateFiles() {
  if (!fs.existsSync(CANDIDATES_DIR)) return [];
  return fs.readdirSync(CANDIDATES_DIR)
    .filter(f => f.startsWith('huawei_raw_') && f.endsWith('.jsonl'))
    .sort();
}

function readRawPosts(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function rawPostKey(rawPost) {
  return rawPost.source_url || rawPost.id || `${rawPost.title || ''}:${(rawPost.question || '').slice(0, 80)}`;
}

function loadProcessedIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : { posts: {} };
  } catch {
    return { posts: {} };
  }
}

function saveProcessedIndex(index) {
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

function markProcessed(index, rawPost, status, data = {}) {
  const key = rawPostKey(rawPost);
  index.posts[key] = {
    status,
    source_url: rawPost.source_url || '',
    title: rawPost.title || '',
    updated_at: new Date().toISOString(),
    ...data,
  };
}

async function main() {
  const args = process.argv.slice(2);

  // Load .env
  try {
    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const [k, ...v] = line.split('=');
        if (k && v.length) process.env[k.trim()] = v.join('=').trim();
      }
    }
  } catch {}

  const opts = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    template: args.includes('--template') || !process.env.ANTHROPIC_API_KEY,
    dryRun: args.includes('--dry-run'),
    manual: args.includes('--manual'),
    force: args.includes('--force'),
  };

  // Determine which raw posts to process
  let rawPosts = [];

  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0 && fileIdx + 1 < args.length) {
    rawPosts = readRawPosts(args[fileIdx + 1]);
  } else {
    const postIdx = args.indexOf('--post-id');
    if (postIdx >= 0 && postIdx + 1 < args.length) {
      const postId = args[postIdx + 1];
      const files = listCandidateFiles();
      for (const f of files) {
        const posts = readRawPosts(path.join(CANDIDATES_DIR, f));
        rawPosts = posts.filter(p => p.id === postId);
        if (rawPosts.length > 0) break;
      }
    } else {
      // Process all unprocessed raw posts
      const files = listCandidateFiles();
      for (const f of files) {
        rawPosts.push(...readRawPosts(path.join(CANDIDATES_DIR, f)));
      }
    }
  }

  if (rawPosts.length === 0) {
    console.log('\n  No raw posts found. Run scraper first:');
    console.log('  node scripts/scrapers/huawei-forum.js\n');
    return;
  }

  const seenInRun = new Set();
  rawPosts = rawPosts.filter(p => {
    const key = rawPostKey(p);
    if (seenInRun.has(key)) return false;
    seenInRun.add(key);
    return true;
  });

  const processedIndex = loadProcessedIndex();
  const beforeProcessedFilter = rawPosts.length;
  if (!opts.force) {
    rawPosts = rawPosts.filter(p => {
      const entry = processedIndex.posts[rawPostKey(p)];
      return !entry || !['stored', 'duplicate'].includes(entry.status);
    });
  }

  console.log(`\n  Processing ${rawPosts.length} raw post(s)...`);
  if (opts.template) console.log('  Mode: template-based (no LLM API key)');
  else console.log('  Mode: LLM extraction');
  if (!opts.force) console.log(`  Skipped: ${beforeProcessedFilter - rawPosts.length} already processed/duplicate post(s)`);

  if (opts.dryRun) {
    console.log('\n  DRY RUN — would process:\n');
    for (const p of rawPosts) {
      console.log(`  • ${p.id}: ${(p.title || '').slice(0, 60)}`);
      console.log(`    Source: ${p.source_url || 'N/A'}`);
      const result = await processRawPost(p, { ...opts, template: true });
      console.log(`    Tags: ${Object.keys(result.dc?.tags || {}).join(', ')}`);
      console.log(`    Valid: ${result.ok ? 'yes' : `no (${result.errors.length} errors)`}`);
      console.log('');
    }
    return;
  }

  if (opts.manual) {
    console.log('\n  MANUAL mode — generating template only:\n');
    for (const p of rawPosts) {
      const result = templateExtract(p);
      const dc = {
        dc_id: generateId('hm'),
        source: 'huawei_forum',
        source_url: p.source_url || '',
        title: result.title,
        symptom: result.symptom,
        root_cause: result.root_cause,
        fix: result.fix,
        tags: result.tags,
        evolver_meta: { promoted_to_gene: false, matched_count: 0, related_genes: [], ingested_at: new Date().toISOString() },
      };
      console.log(JSON.stringify(dc, null, 2));
      console.log('\n---\n');
    }
    return;
  }

  // Process each raw post
  let success = 0;
  let failed = 0;

  for (const raw of rawPosts) {
    console.log(`  Processing: ${(raw.title || '').slice(0, 60)}...`);
    const result = await processRawPost(raw, opts);

    if (result.ok) {
      const storeResult = storeCase(result.dc);
      if (storeResult.ok) {
        success++;
        markProcessed(processedIndex, raw, 'stored', { dc_id: result.dc.dc_id });
        saveProcessedIndex(processedIndex);
        console.log(`  ✓ Stored: ${result.dc.dc_id}`);
      } else {
        failed++;
        if (storeResult.dedupSkipped) {
          markProcessed(processedIndex, raw, 'duplicate', { existing_id: storeResult.existingId || '' });
          saveProcessedIndex(processedIndex);
        }
        console.error(`  ✗ Validation failed: ${storeResult.errors.join(', ')}`);
      }
    } else {
      failed++;
      console.error(`  ✗ Extraction failed: ${result.errors.join(', ')}`);
    }
  }

  console.log(`\n  Done: ${success} stored, ${failed} failed\n`);
  if (success > 0) {
    console.log(`  Verify: node scripts/debug-case/search.js --query "test"\n`);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { processRawPost, templateExtract, llmExtract };
