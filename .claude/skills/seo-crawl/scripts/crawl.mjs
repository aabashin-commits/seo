#!/usr/bin/env node
/**
 * seo-crawl — обход сайта для SEO-аудита без платных краулеров.
 * Node 18+, без внешних зависимостей.
 *
 * Использование:
 *   node crawl.mjs https://example.com --limit 500 --delay 300 --out data/crawl.csv
 *
 * Выход: два CSV в UTF-8 с BOM — основной отчёт по страницам и список битых ссылок.
 */

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('-')) {
  console.error('Usage: node crawl.mjs <url> [--limit N] [--delay MS] [--out FILE] [--ignore-robots]');
  process.exit(1);
}

const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const RAW_START = args[0].startsWith('http') ? args[0] : `https://${args[0]}`;
const START = new URL(RAW_START).href; // нормализуем: добавляет слеш корню, убирает хеш
const LIMIT = parseInt(opt('limit', '500'), 10);
const DELAY = parseInt(opt('delay', '300'), 10);
const OUT = opt('out', 'crawl.csv');
const UA = 'Mozilla/5.0 (compatible; seo-crawl/1.0; +SEO audit)';
const TIMEOUT = 20000;

const origin = new URL(START).origin;
const host = new URL(START).host;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------
async function get(url, { method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: ctrl.signal,
    });
    return res;
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message, headers: new Map() };
  } finally {
    clearTimeout(t);
  }
}

// ---------- robots.txt ----------
async function loadRobots() {
  const rules = { disallow: [], allow: [], sitemaps: [] };
  const res = await get(`${origin}/robots.txt`);
  if (res.status !== 200) return rules;
  const text = await res.text();
  let active = false;
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') active = val === '*';
    else if (key === 'sitemap') rules.sitemaps.push(val);
    else if (active && key === 'disallow' && val) rules.disallow.push(val);
    else if (active && key === 'allow' && val) rules.allow.push(val);
  }
  return rules;
}

const matchRule = (path, rule) => {
  // поддержка * и $ как в спецификации robots
  const re = new RegExp('^' + rule.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$'));
  return re.test(path);
};

function blockedByRobots(url, rules) {
  if (flag('ignore-robots')) return false;
  const path = new URL(url).pathname + new URL(url).search;
  const allowed = rules.allow.some((r) => matchRule(path, r));
  if (allowed) return false;
  return rules.disallow.some((r) => matchRule(path, r));
}

// ---------- sitemap ----------
async function loadSitemap(url, seen = new Set(), depth = 0) {
  if (depth > 3 || seen.has(url)) return [];
  seen.add(url);
  const res = await get(url);
  if (res.status !== 200) return [];
  const xml = await res.text();
  const isIndex = /<sitemapindex/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
  if (!isIndex) return locs;
  const out = [];
  for (const s of locs.slice(0, 20)) out.push(...(await loadSitemap(s, seen, depth + 1)));
  return out;
}

// ---------- парсинг HTML ----------
const strip = (s) => (s || '').replace(/\s+/g, ' ').trim();
const one = (html, re) => { const m = html.match(re); return m ? strip(m[1]) : ''; };

function parse(html) {
  const head = html.slice(0, 200000);
  const title = one(head, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = one(head, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
    || one(head, /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
  const canonical = one(head, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || one(head, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const robotsMeta = one(head, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1].replace(/<[^>]+>/g, '')));
  const h2count = (html.match(/<h2[^>]*>/gi) || []).length;
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgsNoAlt = imgs.filter((t) => !/\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const hreflang = (html.match(/rel=["']alternate["'][^>]*hreflang=/gi) || []).length;
  const schema = (html.match(/application\/ld\+json/gi) || []).length;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const words = strip(text).split(' ').filter((w) => w.length > 1).length;
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  return { title, description, canonical, robotsMeta, h1s, h2count, imgsNoAlt, imgTotal: imgs.length, hreflang, schema, words, links };
}

function normalize(href, base) {
  try {
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(href)) return null;
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

// ---------- CSV ----------
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) =>
  '﻿' + [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';

// ---------- краул ----------
const pages = new Map();     // url -> данные
const broken = [];           // битые ссылки
const externalSeen = new Set();

async function main() {
  const rules = await loadRobots();
  console.error(`robots.txt: ${rules.disallow.length} Disallow, ${rules.sitemaps.length} Sitemap`);

  const queue = [];
  const enqueued = new Set();
  const push = (url, depth, from) => {
    if (!url || enqueued.has(url)) return;
    if (new URL(url).host !== host) return;
    enqueued.add(url);
    queue.push({ url, depth, from });
  };

  // старт: sitemap, если есть
  const smUrls = [...rules.sitemaps];
  if (!smUrls.length) smUrls.push(`${origin}/sitemap.xml`);
  let fromSitemap = new Set();
  for (const sm of smUrls) {
    const list = await loadSitemap(sm);
    list.forEach((u) => fromSitemap.add(u));
  }
  console.error(`sitemap: ${fromSitemap.size} URL`);

  push(START, 0, '');
  for (const u of fromSitemap) push(u, 1, 'sitemap');

  let processed = 0;
  while (queue.length && processed < LIMIT) {
    const { url, depth, from } = queue.shift();
    if (pages.has(url)) continue;

    if (blockedByRobots(url, rules)) {
      pages.set(url, { url, status: 'blocked_by_robots', depth, found_on: from });
      continue;
    }

    const res = await get(url);
    processed++;
    const status = res.status;
    const loc = res.headers?.get ? res.headers.get('location') : null;
    const ctype = res.headers?.get ? (res.headers.get('content-type') || '') : '';

    const row = {
      url,
      status,
      redirect_to: loc ? (normalize(loc, url) || loc) : '',
      depth,
      found_on: from,
      in_sitemap: fromSitemap.has(url) ? 1 : 0,
      content_type: ctype.split(';')[0],
      error: res.error || '',
    };

    if (status >= 300 && status < 400 && loc) {
      const next = normalize(loc, url);
      pages.set(url, row);
      if (next) push(next, depth, url);
      await sleep(DELAY);
      continue;
    }

    if (status >= 400 || status === 0) {
      pages.set(url, row);
      broken.push({ broken_url: url, status: status || res.error, found_on: from });
      await sleep(DELAY);
      continue;
    }

    if (!/text\/html/i.test(ctype)) {
      pages.set(url, row);
      await sleep(DELAY);
      continue;
    }

    const html = await res.text();
    const p = parse(html);
    Object.assign(row, {
      title: p.title,
      title_len: p.title.length,
      description: p.description,
      description_len: p.description.length,
      h1: p.h1s[0] || '',
      h1_count: p.h1s.length,
      h2_count: p.h2count,
      canonical: p.canonical ? (normalize(p.canonical, url) || p.canonical) : '',
      canonical_self: p.canonical ? (normalize(p.canonical, url) === url ? 1 : 0) : '',
      meta_robots: p.robotsMeta,
      noindex: /noindex/i.test(p.robotsMeta) ? 1 : 0,
      words: p.words,
      images: p.imgTotal,
      images_no_alt: p.imgsNoAlt,
      hreflang: p.hreflang,
      jsonld: p.schema,
      links_total: p.links.length,
    });
    pages.set(url, row);

    let internal = 0;
    for (const href of p.links) {
      const abs = normalize(href, url);
      if (!abs) continue;
      if (new URL(abs).host === host) {
        internal++;
        push(abs, depth + 1, url);
      } else {
        externalSeen.add(abs);
      }
    }
    row.links_internal = internal;

    if (processed % 25 === 0) console.error(`обработано ${processed}, в очереди ${queue.length}`);
    await sleep(DELAY);
  }

  // ---------- выгрузка ----------
  const headers = ['url','status','redirect_to','depth','found_on','in_sitemap','content_type',
    'title','title_len','description','description_len','h1','h1_count','h2_count',
    'canonical','canonical_self','meta_robots','noindex','words','images','images_no_alt',
    'hreflang','jsonld','links_total','links_internal','error'];
  const rows = [...pages.values()];
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, toCsv(headers, rows));

  const brokenOut = OUT.replace(/\.csv$/, '') + '-broken.csv';
  fs.writeFileSync(brokenOut, toCsv(['broken_url','status','found_on'], broken));

  // ---------- сводка ----------
  const html = rows.filter((r) => /text\/html/.test(r.content_type || ''));
  const cnt = (fn) => html.filter(fn).length;
  const dupes = (key) => {
    const m = new Map();
    html.forEach((r) => { const v = (r[key] || '').trim(); if (v) m.set(v, (m.get(v) || 0) + 1); });
    return [...m.values()].filter((n) => n > 1).length;
  };

  const summary = {
    'Всего URL': rows.length,
    'HTML-страниц': html.length,
    'Код 200': cnt((r) => r.status === 200),
    'Редиректы 3xx': rows.filter((r) => r.status >= 300 && r.status < 400).length,
    'Ошибки 4xx': rows.filter((r) => r.status >= 400 && r.status < 500).length,
    'Ошибки 5xx': rows.filter((r) => r.status >= 500).length,
    'Недоступны': rows.filter((r) => r.status === 0).length,
    'Пустой title': cnt((r) => !r.title),
    'title вне 50–65': cnt((r) => r.title && (r.title_len < 50 || r.title_len > 65)),
    'Дубли title': dupes('title'),
    'Пустой description': cnt((r) => !r.description),
    'Дубли description': dupes('description'),
    'h1 отсутствует': cnt((r) => r.h1_count === 0),
    'h1 больше одного': cnt((r) => r.h1_count > 1),
    'noindex': cnt((r) => r.noindex === 1),
    'canonical отсутствует': cnt((r) => !r.canonical),
    'canonical не на себя': cnt((r) => r.canonical && r.canonical_self === 0),
    'Изображений без alt': html.reduce((s, r) => s + (r.images_no_alt || 0), 0),
    'Тонкий контент (<300 слов)': cnt((r) => r.words > 0 && r.words < 300),
    'Глубина больше 3 кликов': cnt((r) => r.depth > 3),
    'Битых ссылок': broken.length,
    'Внешних ссылок (уникальных)': externalSeen.size,
  };

  console.log('\n=== СВОДКА ===');
  for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(30, '.')} ${v}`);
  console.log(`\nОтчёт:        ${OUT}`);
  console.log(`Битые ссылки: ${brokenOut}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
