#!/usr/bin/env node
/**
 * huawei-forum.js — Scrape resolved cases from Huawei Developer Forum
 *
 * The forum uses infinite scroll (no page URLs). Strategy:
 *   1. Load listing page ONCE
 *   2. Scroll until enough unseen resolved post URLs are collected
 *   3. Scrape each post detail with a small worker pool
 *
 * Usage:
 *   node scripts/scrapers/huawei-forum.js --count 30         # scrape up to 30 new resolved posts
 *   node scripts/scrapers/huawei-forum.js --count 100        # scrape up to 100 new resolved posts
 *   node scripts/scrapers/huawei-forum.js --concurrency 4    # use 4 detail-page workers
 *   node scripts/scrapers/huawei-forum.js --resume           # resume from checkpoint
 *   node scripts/scrapers/huawei-forum.js --status           # show progress
 *   node scripts/scrapers/huawei-forum.js --headless=false   # see the browser
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'debug_cases', 'candidates');
const CHECKPOINT_FILE = path.join(CANDIDATES_DIR, '.checkpoint.json');

const CONFIG = {
  baseUrl: 'https://developer.huawei.com/consumer/cn/forum',
  listingUrl: 'https://developer.huawei.com/consumer/cn/forum/',
  listApiUrl: 'https://svc-drcn.developer.huawei.com/community/servlet/consumer/partnerforumservice/v1/open/getAnswerTopicList',
  topicDetailApiUrl: 'https://svc-drcn.developer.huawei.com/community/servlet/consumer/partnerforumservice/v1/open/getTopicDetail',
  answerListApiUrl: 'https://svc-drcn.developer.huawei.com/community/servlet/consumer/partnerforumservice/v1/open/getAnswerDepthPostList',
  maxPosts: 30,
  postsPerPage: 9,        // deprecated: only used to map old --pages calls
  listPageSize: 100,
  maxListPages: 30,
  useListApi: true,
  useDetailApi: true,
  apiRequestDelay: 150,
  pageLoadTimeout: 45000,
  listInitialWait: 2500,
  detailWait: 1200,
  delayBetweenPosts: 100,
  detailConcurrency: 3,
  maxRetries: 2,
  headless: true,
  // Scroll tuning
  scrollStep: 900,        // px per scrollBy
  scrollWait: 450,        // ms between scrolls
  maxScrollIterations: 80, // max scroll attempts
  scrollIdleThreshold: 12, // stop after N consecutive scrolls yield nothing
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '[INFO]', warn: '[WARN]', err: '[ERR]', ok: '[OK]' }[level] || '[INFO]';
  console.log(`${ts} ${prefix} ${msg}`);
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')); }
  catch { return { postIds: [], savedCount: 0 }; }
}

function saveCheckpoint(st) {
  fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(st, null, 2), 'utf8');
}

function loadExistingRawSources() {
  const sources = new Set();
  if (!fs.existsSync(CANDIDATES_DIR)) return sources;

  for (const f of fs.readdirSync(CANDIDATES_DIR)) {
    if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
    const fp = path.join(CANDIDATES_DIR, f);
    try {
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        try {
          const post = JSON.parse(line);
          if (post.source_url) sources.add(post.source_url);
        } catch {}
      }
    } catch {}
  }

  return sources;
}

function saveRawPost(post, existingRawSources = loadExistingRawSources()) {
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  if (post.source_url && existingRawSources.has(post.source_url)) {
    return { saved: false, duplicate: true };
  }
  const date = new Date().toISOString().slice(0, 10);
  const fp = path.join(CANDIDATES_DIR, `huawei_raw_${date}.jsonl`);
  fs.appendFileSync(fp, JSON.stringify(post) + '\n', 'utf8');
  if (post.source_url) existingRawSources.add(post.source_url);
  return { saved: true, filePath: fp };
}

function normalizeScrapeOptions(opts = {}) {
  const cfg = { ...CONFIG, ...opts };

  if (opts.maxPosts == null && opts.count != null) cfg.maxPosts = opts.count;
  if (opts.maxPosts == null && opts.limit != null) cfg.maxPosts = opts.limit;
  if (opts.maxPosts == null && opts.maxPages != null) {
    cfg.maxPosts = Number(opts.maxPages) * cfg.postsPerPage;
  }

  cfg.maxPosts = Math.max(1, parseInt(cfg.maxPosts, 10) || CONFIG.maxPosts);
  cfg.detailConcurrency = Math.max(1, parseInt(cfg.detailConcurrency || cfg.concurrency, 10) || CONFIG.detailConcurrency);
  cfg.listPageSize = Math.max(1, parseInt(cfg.listPageSize, 10) || CONFIG.listPageSize);
  cfg.maxListPages = Math.max(1, parseInt(cfg.maxListPages, 10) || CONFIG.maxListPages);
  cfg.maxScrollIterations = Math.max(1, parseInt(cfg.maxScrollIterations, 10) || CONFIG.maxScrollIterations);
  cfg.scrollIdleThreshold = Math.max(1, parseInt(cfg.scrollIdleThreshold, 10) || CONFIG.scrollIdleThreshold);
  cfg.useListApi = cfg.useListApi !== false;
  cfg.useDetailApi = cfg.useDetailApi !== false;
  return cfg;
}

function stripHtml(input = '') {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function selectPostsToScrape(posts, checkpoint, existingRawSources, maxPosts) {
  const postIds = new Set(checkpoint?.postIds || []);
  const seenUrls = new Set();
  const selected = [];

  for (const post of posts) {
    if (!post.isResolved) continue;
    if (postIds.has(post.id)) continue;
    if (existingRawSources.has(post.url)) continue;
    if (seenUrls.has(post.url)) continue;
    selected.push(post);
    seenUrls.add(post.url);
    if (selected.length >= maxPosts) break;
  }

  return selected;
}

function topicListItemToPost(item) {
  if (!item || !item.topicId || !item.title) return null;
  const fid = item.fid || item.sectionId || '';
  const url = `${CONFIG.baseUrl}/topic/${item.topicId}${fid ? `?fid=${encodeURIComponent(fid)}` : ''}`;
  return {
    id: `hm_${item.topicId}`,
    topicId: item.topicId,
    fid,
    postId: item.postId || item.pid || '',
    url,
    title: String(item.title).trim(),
    content: stripHtml(item.content || ''),
    tags: (item.topicTagInfoList || []).map(t => t.tagName).filter(Boolean),
    isResolved: Number(item.solved) === 1,
  };
}

async function postForumApi(url, body) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Use Node.js 18+ or disable list API mode.');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN',
      'content-type': 'application/json;charset=UTF-8',
      'origin': 'https://developer.huawei.com',
      'referer': 'https://developer.huawei.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Forum API HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Forum API error ${json.code}: ${json.message || 'unknown'}`);
  return json;
}

async function fetchTopicListPage(pageIndex, pageSize, cfg = CONFIG) {
  const json = await postForumApi(cfg.listApiUrl || CONFIG.listApiUrl, {
    filterCondition: 1,
    pageIndex,
    pageSize,
    isNeedTop: 0,
    sourceType: 1,
  });
  return Array.isArray(json.resultList) ? json.resultList : [];
}

async function fetchTopicDetail(topicId, cfg = CONFIG) {
  const json = await postForumApi(cfg.topicDetailApiUrl || CONFIG.topicDetailApiUrl, { topicId });
  return json.result || null;
}

async function fetchAnswerList(topicId, postId, cfg = CONFIG) {
  if (!topicId || !postId) return [];
  const json = await postForumApi(cfg.answerListApiUrl || CONFIG.answerListApiUrl, {
    pageIndex: 1,
    pageSize: 20,
    topicId,
    postId,
    desc: '1',
    depth: 1,
    deleted: 0,
    fromPC: 1,
    orderItem: 'likes',
  });
  return Array.isArray(json.resultList) ? json.resultList : [];
}

async function collectPostsFromListApi(logFn, cfg, checkpoint, existingRawSources) {
  const collectedByUrl = new Map();
  let selected = [];

  for (let pageIndex = 1; pageIndex <= cfg.maxListPages; pageIndex++) {
    const items = await fetchTopicListPage(pageIndex, cfg.listPageSize, cfg);
    if (items.length === 0) {
      logFn('info', `List API page ${pageIndex}: no posts returned`);
      break;
    }

    for (const item of items) {
      const post = topicListItemToPost(item);
      if (post) collectedByUrl.set(post.url, post);
    }

    const allPosts = [...collectedByUrl.values()];
    const resolvedPosts = allPosts.filter(p => p.isResolved);
    selected = selectPostsToScrape(resolvedPosts, checkpoint, existingRawSources, cfg.maxPosts);

    logFn('info', `List API page ${pageIndex}: read ${allPosts.length} posts, ${resolvedPosts.length} resolved, ${selected.length}/${cfg.maxPosts} usable`);
    if (selected.length >= cfg.maxPosts) break;
    if (items.length < cfg.listPageSize) break;

    if (cfg.apiRequestDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, cfg.apiRequestDelay));
    }
  }

  const allPosts = [...collectedByUrl.values()];
  const resolvedPosts = allPosts.filter(p => p.isResolved);
  return { allPosts, resolvedPosts, toScrape: selected, source: 'list_api' };
}

async function collectPostsForTarget(page, logFn, cfg, checkpoint, existingRawSources) {
  const selector = '.topic-link, a[class*="topic-link"], a[href*="/forum/topic/"]';
  const collectedByUrl = new Map();
  let prevCollected = 0;
  let noNewSteps = 0;
  let selected = [];

  for (let i = 0; i < cfg.maxScrollIterations; i++) {
    const visiblePosts = await extractPostsFromPage(page);
    for (const post of visiblePosts) collectedByUrl.set(post.url, post);

    const collected = [...collectedByUrl.values()];
    const resolved = collected.filter(p => p.isResolved);
    selected = selectPostsToScrape(resolved, checkpoint, existingRawSources, cfg.maxPosts);

    if (selected.length >= cfg.maxPosts) {
      logFn('ok', `Collected target: ${selected.length}/${cfg.maxPosts} unseen resolved posts`);
      break;
    }

    const currentCount = collectedByUrl.size;
    if (currentCount > prevCollected) {
      logFn('info', `Scroll ${i}: collected ${currentCount} posts, ${resolved.length} resolved, ${selected.length}/${cfg.maxPosts} usable`);
      prevCollected = currentCount;
      noNewSteps = 0;
    } else {
      noNewSteps++;
    }
    if (noNewSteps >= cfg.scrollIdleThreshold) {
      logFn('info', `No new posts for ${cfg.scrollIdleThreshold} scrolls — using ${selected.length}/${cfg.maxPosts} usable posts`);
      break;
    }

    await scrollListing(page, cfg);
  }

  const domCount = await page.evaluate((sel) =>
    document.querySelectorAll(sel).length, selector
  );
  logFn('info', `Listing DOM currently has ${domCount} topic links`);

  const allPosts = [...collectedByUrl.values()];
  const resolvedPosts = allPosts.filter(p => p.isResolved);
  return { allPosts, resolvedPosts, toScrape: selected };
}

async function scrollListing(page, cfg) {
  await page.evaluate((step) => {
    window.scrollBy(0, step);
    const root = document.scrollingElement || document.documentElement || document.body;
    if (root) root.scrollTop += step;

    const scrollables = [...document.querySelectorAll('body *')]
      .filter(el => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY || '';
        return el.scrollHeight > el.clientHeight + 120 &&
          !['hidden', 'visible'].includes(overflowY);
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
      .slice(0, 3);

    for (const el of scrollables) {
      el.scrollTop += step;
    }
  }, cfg.scrollStep);

  await page.mouse.wheel(0, cfg.scrollStep).catch(() => {});
  await page.waitForTimeout(cfg.scrollWait);
}

// ─── Main scraper ─────────────────────────────────────────────────────────

async function scrapeForum(opts = {}) {
  const cfg = normalizeScrapeOptions(opts);
  const cp = opts.resume ? loadCheckpoint() : { postIds: [] };
  const existingRawSources = loadExistingRawSources();
  const stats = { extracted: cp.postIds.length, errors: 0, new: 0, duplicates: 0, totalResolved: 0 };

  cp.postIds = Array.isArray(cp.postIds) ? cp.postIds : [];
  cp.savedCount = cp.savedCount || 0;
  cp.targetCount = cfg.maxPosts;
  cp.detailConcurrency = cfg.detailConcurrency;
  cp.inProgress = true;
  cp.started_at = new Date().toISOString();
  saveCheckpoint(cp);

  log('info', `Starting: target=${cfg.maxPosts} new posts, concurrency=${cfg.detailConcurrency}, headless=${cfg.headless}${opts.resume ? ' (resume)' : ''}`);

  const browser = await chromium.launch({
    headless: cfg.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(cfg.pageLoadTimeout);

  try {
    // Phase 1: collect listing URLs. The public SPA calls a count-friendly JSON
    // endpoint; browser scrolling remains as a fallback if that endpoint changes.
    let listing = null;
    if (cfg.useListApi) {
      log('info', 'Loading forum listing via list API...');
      try {
        listing = await collectPostsFromListApi(log, cfg, cp, existingRawSources);
        log('ok', 'List API loaded');
      } catch (e) {
        log('warn', `List API failed (${e.message}); falling back to browser scrolling`);
      }
    }

    if (!listing) {
      log('info', 'Loading forum listing in browser...');
      await page.goto(cfg.listingUrl, { waitUntil: 'domcontentloaded', timeout: cfg.pageLoadTimeout });
      await page.waitForSelector('.topic-link, a[class*="topic-link"]', { timeout: 15000 }).catch(() => {
        log('warn', 'Topic links not found via selector, waiting for SPA...');
      });
      await page.waitForTimeout(cfg.listInitialWait);
      log('ok', 'Listing loaded');
      listing = await collectPostsForTarget(page, log, cfg, cp, existingRawSources);
    }

    const { allPosts, resolvedPosts, toScrape } = listing;
    stats.totalResolved = resolvedPosts.length;
    log('info', `Total: ${allPosts.length} posts, ${resolvedPosts.length} resolved`);

    if (toScrape.length === 0) {
      log('info', 'No new resolved posts to scrape');
    }

    await scrapePostsConcurrently(ctx, toScrape, cfg, cp, existingRawSources, stats);

  } catch (e) {
    log('err', `Fatal: ${e.message}`);
    throw e;
  } finally {
    cp.inProgress = false;
    cp.lastRun = stats;
    cp.finished_at = new Date().toISOString();
    saveCheckpoint(cp);
    await browser.close();
    log('ok', `Done: ${stats.new} new, ${stats.duplicates} duplicate, ${stats.extracted} total, ${stats.totalResolved} resolved on page`);
  }

  return stats;
}

async function scrapePostsConcurrently(ctx, posts, cfg, checkpoint, existingRawSources, stats) {
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(cfg.detailConcurrency, posts.length);

  async function worker(workerId) {
    const detailPage = await ctx.newPage();
    detailPage.setDefaultTimeout(cfg.pageLoadTimeout);

    try {
      while (nextIndex < posts.length) {
        const pp = posts[nextIndex++];
        const raw = await scrapePost(detailPage, pp, cfg);
        completed++;

        if (raw) {
          const saved = saveRawPost(raw, existingRawSources);
          if (saved.saved) {
            stats.new++;
            checkpoint.savedCount = (checkpoint.savedCount || 0) + 1;
          } else {
            stats.duplicates++;
          }
          checkpoint.postIds.push(pp.id);
          stats.extracted = checkpoint.postIds.length;
          checkpoint.lastPost = { id: pp.id, title: raw.title, at: new Date().toISOString() };
          checkpoint.lastRun = stats;
          saveCheckpoint(checkpoint);
          log('ok', `[${completed}/${posts.length}] worker ${workerId}: ${raw.title.slice(0, 50)}`);
        } else {
          stats.errors++;
          checkpoint.lastRun = stats;
          saveCheckpoint(checkpoint);
        }

        if (cfg.delayBetweenPosts > 0) {
          await detailPage.waitForTimeout(cfg.delayBetweenPosts);
        }
      }
    } finally {
      await detailPage.close().catch(() => {});
    }
  }

  if (workerCount === 0) return;
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
}

// ─── Extract post URLs and resolve status from listing ────────────────────

async function extractPostsFromPage(page) {
  return await page.evaluate(() => {
    const items = [];

    const selectors = [
      '.topic-link',
      'a[class*="topic-link"]',
      'a.topic-link',
      '[class*="topic-card"] a[href*="topic"]',
      'a[href*="/forum/topic/"]',
      '.post-title a',
      '[class*="post-item"] a[href*="topic"]',
      '.list-item a[href*="topic"]',
    ];

    let topicLinks = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        topicLinks = found;
        break;
      }
    }

    for (const link of topicLinks) {
      const href = link.href || link.getAttribute('href') || '';
      const title = (link.textContent || '').trim();
      if (!href || !title || title.length < 3) continue;

      const fullUrl = href.startsWith('http') ? href : `https://developer.huawei.com${href.startsWith('/') ? '' : '/'}${href}`;

      // Check for "已解决" badge nearby
      const parent = link.parentElement;
      const resolvedBadge = parent ? parent.querySelector('.resolved, [class*="solved"], [class*="resolved"]') : null;
      const resolvedText = parent ? parent.textContent || '' : '';

      const isResolved = resolvedBadge !== null ||
                         resolvedText.includes('已解决') ||
                         (link.previousElementSibling?.textContent || '').includes('已解决') ||
                         (link.parentElement?.previousElementSibling?.textContent || '').includes('已解决');

      const id = `hm_${fullUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-30)}`;

      items.push({ id, url: fullUrl, title, isResolved });
    }

    // Deduplicate by URL
    const seen = new Set();
    return items.filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  });
}

// ─── Scrape a single post detail page ─────────────────────────────────────

function parseTopicIdFromUrl(url = '') {
  const m = String(url).match(/\/topic\/([^?/#]+)/);
  return m ? m[1] : '';
}

function buildRawPostFromApi(listingPost, detail, replies, url) {
  const title = detail?.title || listingPost?.title || '';
  const question = stripHtml(detail?.content || listingPost?.content || '');
  const cleanReplies = replies
    .map(r => ({
      text: stripHtml(r.content || ''),
      adopted: Number(r.adopted) === 1,
      recommended: Number(r.recommended) === 1 || Number(r.officialReply) === 1,
    }))
    .filter(r => r.text.length > 0);

  const accepted = cleanReplies.find(r => r.adopted) ||
                   cleanReplies.find(r => r.recommended) ||
                   cleanReplies[0];
  const answer = accepted?.text || '';
  const allReplies = cleanReplies
    .map(r => r.text)
    .filter(text => text !== answer)
    .slice(0, 4);
  const tags = [
    ...(detail?.topicTagInfoList || []).map(t => t.tagName).filter(Boolean),
    ...(listingPost?.tags || []),
  ];

  return {
    id: `hm_raw_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    source: 'huawei_forum',
    source_url: url,
    scraped_at: new Date().toISOString(),
    title,
    question: question.slice(0, 5000),
    answer: answer.slice(0, 5000),
    allReplies: allReplies.map(r => r.slice(0, 2000)),
    tags: [...new Set(tags)],
  };
}

async function scrapePostFromApi(postOrUrl, cfg) {
  const listingPost = typeof postOrUrl === 'string' ? { url: postOrUrl } : postOrUrl;
  const url = listingPost.url || String(postOrUrl);
  const topicId = listingPost.topicId || parseTopicIdFromUrl(url);
  if (!topicId) throw new Error('Could not parse topicId from URL');

  const detail = await fetchTopicDetail(topicId, cfg);
  if (!detail) throw new Error('Topic detail API returned no result');
  const replies = await fetchAnswerList(topicId, detail.postId || listingPost.postId, cfg);
  const raw = buildRawPostFromApi(listingPost, detail, replies, url);
  if (!raw.title || raw.title.length < 3) throw new Error('Could not extract title');
  if (!raw.question && !raw.answer) throw new Error('Could not extract question or answer');
  return raw;
}

async function scrapePost(page, postOrUrl, cfg) {
  const listingPost = typeof postOrUrl === 'string' ? { url: postOrUrl } : postOrUrl;
  const url = listingPost.url || String(postOrUrl);

  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    try {
      if (cfg.useDetailApi) {
        try {
          return await scrapePostFromApi(listingPost, cfg);
        } catch (e) {
          log('warn', `Detail API fallback ${parseTopicIdFromUrl(url)}: ${e.message}`);
        }
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.pageLoadTimeout });
      await page.waitForSelector('h1, .topic-title, app-reply-card', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const post = await page.evaluate(() => {
        const title = document.querySelector('h1')?.textContent?.trim() ||
                      document.title?.replace(/[-–].*$/, '').trim() || '';

        // Extract question from CKEditor preview
        let questionText = '';
        const questionPreviews = document.querySelectorAll('aci-ck4-preview.topic-post-content-ckeditor:not(.content-word)');
        if (questionPreviews.length > 0) {
          const qEl = questionPreviews[0].querySelector('.cke-article');
          if (qEl) questionText = qEl.innerText?.trim() || '';
        }

        if (!questionText || questionText.length < 10) {
          const firstReply = document.querySelector('app-reply-card');
          if (firstReply) {
            const cardContent = firstReply.querySelector('.reply-card');
            if (cardContent) questionText = cardContent.innerText?.trim()?.slice(0, 2000) || '';
          }
        }

        // Extract answer from reply cards
        let answerText = '';
        const replyCards = document.querySelectorAll('app-reply-card');
        for (const card of replyCards) {
          const cardHTML = card.innerHTML || '';
          if (cardHTML.includes('已采纳') || cardHTML.includes('accepted') ||
              cardHTML.includes('采纳答复') || cardHTML.includes('recommend')) {
            const textEl = card.querySelector('.ck-html .cke-article, .reply-card, .content-word');
            if (textEl) answerText = textEl.innerText?.trim() || '';
            break;
          }
        }
        if (!answerText || answerText.length < 10) {
          const targetIdx = replyCards.length > 1 ? 1 : 0;
          const card = replyCards[targetIdx];
          if (card) {
            const textEl = card.querySelector('.ck-html .cke-article, .reply-card');
            if (textEl) answerText = textEl.innerText?.trim() || '';
          }
        }

        // All replies
        const allReplies = [];
        for (const card of replyCards) {
          const textEl = card.querySelector('.ck-html .cke-article, .reply-card');
          if (textEl) {
            const t = textEl.innerText?.trim();
            if (t && t.length > 20) allReplies.push(t);
          }
        }

        // Tags
        const tags = [];
        document.querySelectorAll('[class*="tag"], .ant-tag, .ant-badge').forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length < 30 && t.length > 1) tags.push(t);
        });

        return {
          title: title,
          question: questionText.slice(0, 5000),
          answer: answerText.slice(0, 5000),
          allReplies: allReplies.slice(1, 4).map(r => r.slice(0, 2000)),
          tags: [...new Set(tags)],
        };
      });

      if (!post.title || post.title.length < 3) {
        throw new Error('Could not extract title');
      }
      if (!post.question && !post.answer) {
        throw new Error('Could not extract question or answer');
      }

      return {
        id: `hm_raw_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        source: 'huawei_forum',
        source_url: url,
        scraped_at: new Date().toISOString(),
        title: post.title,
        question: post.question,
        answer: post.answer,
        allReplies: post.allReplies || [],
        tags: post.tags,
      };

    } catch (e) {
      if (attempt < cfg.maxRetries - 1) {
        log('warn', `Retry ${url.split('/').pop()}: ${e.message}`);
        await page.waitForTimeout(2000);
      } else {
        log('err', `Failed: ${url.split('/').pop()} - ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opts = {};

  opts.headless = !args.some(a => a.startsWith('--headless=false') || a === '--visible');

  const countIdx = args.findIndex(a => ['--count', '--limit', '--max-posts'].includes(a));
  if (countIdx >= 0 && countIdx + 1 < args.length) {
    opts.maxPosts = parseInt(args[countIdx + 1], 10) || CONFIG.maxPosts;
  }

  const pagesIdx = args.indexOf('--pages');
  if (pagesIdx >= 0 && pagesIdx + 1 < args.length) {
    opts.maxPages = parseInt(args[pagesIdx + 1], 10);
    console.log('  [WARN] --pages is deprecated for an infinite-scroll forum. Use --count instead.');
  }

  const concurrencyIdx = args.indexOf('--concurrency');
  if (concurrencyIdx >= 0 && concurrencyIdx + 1 < args.length) {
    opts.detailConcurrency = parseInt(args[concurrencyIdx + 1], 10) || CONFIG.detailConcurrency;
  }

  opts.resume = args.includes('--resume');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node scripts/scrapers/huawei-forum.js [options]

Options:
  --count <N>          Target number of new resolved posts to scrape (default: 30)
  --limit <N>          Alias for --count
  --concurrency <N>    Detail-page worker count (default: 3)
  --resume             Resume from checkpoint
  --status             Show checkpoint status
  --headless=false     Show browser window
  --pages <N>          Deprecated compatibility flag; maps to N × 9 posts
  --help               Show this help
    `.trim());
    return;
  }

  if (args.includes('--status')) {
    const cp = loadCheckpoint();
    const files = fs.existsSync(CANDIDATES_DIR) ? fs.readdirSync(CANDIDATES_DIR) : [];
    console.log(`\n  Scraper Status:\n`);
    console.log(`  In progress:      ${cp.inProgress ? 'yes' : 'no'}`);
    console.log(`  Target count:     ${cp.targetCount || 0}`);
    console.log(`  Posts visited:    ${(cp.postIds || []).length}`);
    console.log(`  Posts saved:      ${cp.savedCount || 0}`);
    if (cp.lastRun) {
      console.log(`  Last run:         ${cp.lastRun.new || 0} new, ${cp.lastRun.duplicates || 0} duplicate, ${cp.lastRun.errors || 0} errors`);
    }
    console.log(`  Raw data files:   ${files.filter(f => f.endsWith('.jsonl')).length}`);
    console.log(`  Candidates dir:   ${CANDIDATES_DIR}`);
    console.log(`\n  Run: node scripts/scrapers/huawei-forum.js --count 30\n`);
    return;
  }

  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║  Huawei Developer Forum Scraper          ║`);
  console.log(`  ║  Target: resolved → DebugCase pipeline   ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  scrapeForum(opts).then(stats => {
    console.log(`\n  ┌────────────────────────────────────────┐`);
    console.log(`  │  Complete                              │`);
    console.log(`  │  New: ${String(stats.new).padEnd(33)}│`);
    console.log(`  │  Duplicates: ${String(stats.duplicates).padEnd(26)}│`);
    console.log(`  │  Total: ${String(stats.extracted).padEnd(32)}│`);
    console.log(`  │  Available: ${String(stats.totalResolved).padEnd(29)}│`);
    console.log(`  │  Errors: ${String(stats.errors).padEnd(31)}│`);
    console.log(`  └────────────────────────────────────────┘`);
    console.log(`\n  Next: node scripts/scrapers/llm-extractor.js\n`);
  }).catch(e => {
    console.error(`\n  [FATAL] ${e.message}`);
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = {
  CONFIG,
  normalizeScrapeOptions,
  selectPostsToScrape,
  stripHtml,
  topicListItemToPost,
  fetchTopicListPage,
  fetchTopicDetail,
  fetchAnswerList,
  scrapePostFromApi,
  collectPostsFromListApi,
  scrapeForum,
  extractPostsFromPage,
};
