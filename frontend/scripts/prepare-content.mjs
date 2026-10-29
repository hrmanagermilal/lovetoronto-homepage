import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { createLayoutWriter, restoreWidgets } from './layout.mjs';
import { comparePage } from './text-parity.mjs';
import { sourceSliders } from './sliders.mjs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.ARCHIVE_ROOT) throw new Error('Content regeneration requires ARCHIVE_ROOT pointing to the downloaded source archive. The standalone app builds from existing generated content.');
const root = path.resolve(process.env.ARCHIVE_ROOT);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'offline-manifest.json'), 'utf8'));
const contentDir = path.join(frontend, 'public', 'content');
const archiveDir = path.join(frontend, 'public', 'archive');
const generatedDir = path.join(frontend, 'src', 'generated');
for (const dir of [contentDir, archiveDir, generatedDir]) fs.mkdirSync(dir, { recursive: true });
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
const encoded = value => encodeURI(value).replace(/#/g, '%23').replace(/\?/g, '%3F');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
const sourceKey = address => {
  const url = new URL(address);
  url.hostname = url.hostname === 'www.lovetoronto.org' ? 'lovetoronto.org' : url.hostname;
  url.hash = '';
  for (const name of ['ver', 'tmstv', 'v']) url.searchParams.delete(name);
  return decode(url.href).replace(/\/index\.html(?=$|\?)/, '/');
};
const byFile = new Map();
for (const record of manifest.files) {
  for (const alias of [record.file, record.old, ...(record.aliases || [])]) byFile.set(alias, record);
}
const pageRecords = manifest.files.filter(record => record.kind === 'html');
const pageIds = new Set(pageRecords.map(record => record.file));
const bySource = new Map();
for (const record of manifest.files) {
  for (const address of record.urls) {
    bySource.set(sourceKey(address), record);
  }
}
const externalFile = path.join(contentDir, 'external-links.json');
const externalLinks = fs.existsSync(externalFile) ? JSON.parse(fs.readFileSync(externalFile, 'utf8')) : {};
for (const record of pageRecords) {
  const html = fs.readFileSync(path.join(root, record.file), 'utf8');
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?lovetoronto\.org\/download\/\d+\/(?:\?[^"'<> ]*)?/g)) {
    const url = new URL(match[0].replace(/&amp;/g, '&'));
    const id = sourceKey(url);
    if (bySource.has(id) || externalLinks[id]) continue;
    let current = url.href;
    for (let hop = 0; hop < 8; hop++) {
      const response = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const location = response.headers.get('location');
      if (!location) throw new Error(`Missing archive download ${current}: HTTP ${response.status}`);
      const next = new URL(location, current);
      if (!['lovetoronto.org', 'www.lovetoronto.org'].includes(next.hostname)) {
        externalLinks[id] = next.href;
        console.log(`External download redirect: ${url.pathname} -> ${next.href}`);
        break;
      }
      current = next.href;
    }
    if (!externalLinks[id]) throw new Error(`Could not resolve missing download ${url.href}`);
  }
}
fs.writeFileSync(externalFile, JSON.stringify(externalLinks, null, 2));
const route = (file, anchor = '') => `#/page?${new URLSearchParams({ file, ...(anchor ? { anchor } : {}) })}`;
function reference(raw, record, optional = false) {
  if (!raw || /^(?:data:|mailto:|tel:|javascript:)/i.test(raw)) return { href: raw };
  if (/^webcal:/i.test(raw)) return { href: raw, external: true };
  let url;
  try { url = new URL(raw, `https://archive.local/${encoded(record.file)}`); }
  catch { throw new Error(`Invalid link in ${record.file}: ${raw}`); }
  const anchor = decode(url.hash.slice(1));
  let target;
  if (url.hostname === 'archive.local') {
    const file = decode(url.pathname.slice(1));
    target = byFile.get(file) || byFile.get(`${file}\uF03F${decode(url.search.slice(1))}`) ||
      bySource.get(sourceKey(new URL(`${url.pathname}${url.search}`, 'https://lovetoronto.org'))) ||
      byFile.get(file.replace(/\?/g, '\uF03F'));
    if (!target && raw.startsWith('#')) target = record;
    if (!target && file.startsWith('_offline/')) return { href: '', unavailable: true };
  } else if (['lovetoronto.org', 'www.lovetoronto.org'].includes(url.hostname)) {
    url.hostname = 'lovetoronto.org';
    if (externalLinks[sourceKey(url)]) return { href: externalLinks[sourceKey(url)], external: true };
    target = bySource.get(sourceKey(url));
    if (!target && /^\/(?:en\/)?events-list\/list\/?$/.test(url.pathname)) {
      target = byFile.get(`${url.pathname.startsWith('/en/') ? 'en/' : ''}events-list/index.html`);
    }
  } else {
    target = bySource.get(sourceKey(url));
    if (!target) return { href: url.href, external: true };
  }
  if (!target) {
    if (/\/(?:wp-json|wp-admin)\//.test(url.pathname)) return { href: '', unavailable: true };
    if (/\/(?:wp-login\.php|xmlrpc\.php)$/.test(url.pathname)) return { href: url.href, external: true };
    if (/^\/(?:en\/)?events-list\/(?:month|day)(?:\/|$)/.test(url.pathname)) return { href: url.href, external: true };
    if (['tribe_venue', 'eventDisplay', 's', 'tribe-bar-date', 'tribe_event_display'].some(name => url.searchParams.has(name))) return { href: url.href, external: true };
    if (url.searchParams.has('ical') || /\/feed\/?$/.test(url.pathname)) {
      return { href: url.hostname === 'archive.local' ? new URL(raw, record.source).href : raw, external: true };
    }
    if (optional) return null;
    throw new Error(`Unresolved content link in ${record.file}: ${raw}`);
  }
  if (pageIds.has(target.file)) return { href: route(target.file, anchor), page: target.file };
  return { href: `./archive/${encoded(target.file)}${url.hash}`, asset: target.file };
}

const pages = [];
const contents = [];
const documentLabels = new Map();
const textProof = [];
const remoteStyles = new Set();
for (const record of pageRecords) {
  const $ = load(fs.readFileSync(path.join(root, record.file), 'utf8'));
  $('link[rel="stylesheet"]').each((_, element) => {
    const href = $(element).attr('href');
    if (/^https?:/.test(href) && !bySource.has(sourceKey(href))) remoteStyles.add(href);
  });
}
async function archiveStyleAsset(address) {
  const id = sourceKey(address);
  if (bySource.has(id)) return bySource.get(id);
  const url = new URL(address);
  if (!['lovetoronto.org', 'code.jquery.com'].includes(url.hostname)) throw new Error(`Unexpected stylesheet asset host: ${url.hostname}`);
  const file = `_layout/vendor/${hash(id)}${path.posix.extname(url.pathname) || '.bin'}`;
  const record = { file, source: address };
  bySource.set(id, record);
  byFile.set(file, record);
  const destination = path.join(archiveDir, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let bytes;
  if (fs.existsSync(destination)) bytes = fs.readFileSync(destination);
  else {
    const response = await fetch(address, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Stylesheet asset ${address}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destination, bytes);
    console.log(`Archived layout asset ${address}`);
  }
  if (file.endsWith('.css')) {
    let css = bytes.toString('utf8');
    const replacements = new Map();
    for (const match of css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi)) {
      const raw = (match[2] ?? match[3]).trim();
      if (/^(?:data:|#)/.test(raw) || !raw) continue;
      if (raw.startsWith('./archive/') || raw.startsWith('../../archive/')) continue;
      const cachedFile = path.posix.join(path.posix.dirname(file), decode(raw));
      if (fs.existsSync(path.join(archiveDir, cachedFile))) {
        byFile.set(cachedFile, { file: cachedFile });
        continue;
      }
      const target = await archiveStyleAsset(new URL(raw, address).href);
      replacements.set(match[0], `url("${path.posix.relative(path.posix.dirname(file), target.file)}")`);
    }
    for (const [before, after] of replacements) css = css.split(before).join(after);
    fs.writeFileSync(destination, css);
  }
  return record;
}
for (const address of remoteStyles) await archiveStyleAsset(address);
const cssRecords = new Map();
for (const record of pageRecords) {
  const $ = load(fs.readFileSync(path.join(root, record.file), 'utf8'));
  $('link[rel="stylesheet"]').each((_, element) => {
    const target = reference($(element).attr('href'), record);
    if (target.asset && fs.existsSync(path.join(root, target.asset))) cssRecords.set(target.asset, { file: target.asset });
  });
}
for (const record of cssRecords.values()) {
  const css = fs.readFileSync(path.join(root, record.file), 'utf8');
  for (const match of css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi)) {
    const raw = (match[2] ?? match[3]).trim();
    if (!raw || /^(?:data:|#)/.test(raw)) continue;
    if (!reference(raw, record, true)) await archiveStyleAsset(new URL(raw, `https://lovetoronto.org/${encoded(record.file)}`).href);
  }
}
const layout = createLayoutWriter({ root, archiveDir, contentDir, reference });
for (const record of pageRecords) {
  const sourceHtml = fs.readFileSync(path.join(root, record.file), 'utf8');
  const $ = load(sourceHtml, { scriptingEnabled: false });
  const lang = ($('html').attr('lang') || 'ko').startsWith('en') ? 'en' : 'ko';
  const title = $('title').text();
  const alt = {};
  $('link[rel="alternate"][hreflang]').each((_, element) => {
    const language = ($(element).attr('hreflang') || '').slice(0, 2);
    const target = reference($(element).attr('href'), record);
    if (target.page && ['en', 'ko'].includes(language)) alt[language] = target.page;
  });
  const navigation = [];
  function menuItems(parent) {
    const items = [];
    $(parent).children('li').each((_, element) => {
      if (($(element).attr('class') || '').includes('lang-item')) return;
      const link = $(element).children('a').first();
      const label = link.text().trim();
      if (!label) return;
      const raw = link.attr('href');
      const children = menuItems($(element).children('ul').first());
      const destination = raw?.endsWith('#0') || raw === '#0' ? {} : reference(raw, record);
      items.push({ label, href: destination.href || children[0]?.href || route(record.file), children });
    });
    return items;
  }
  navigation.push(...menuItems($('#grop-mainmenu')));
  const banner = $('.grop-banner-area').attr('style') || '';
  const bannerSource = banner.match(/url\(["']?(.*?)["']?\)/)?.[1];
  const image = bannerSource ? reference(bannerSource.replace(/^["']|["']$/g, ''), record).href : undefined;
  const stylesheets = layout.pageStyles($, record);
  const sliders = sourceSliders(sourceHtml);
  const iconFont = manifest.files.find(item => /\/revicons__.*\.woff$/.test(item.file));
  for (const slider of sliders) {
    let css = slider.arrowCss;
    if (iconFont && slider.arrows) {
      css += `\n@font-face{font-family:"revicons";src:url("${iconFont.urls[0]}") format("woff");font-style:normal;font-weight:normal;}`;
    }
    if (css) stylesheets.push({ href: layout.write(css, record), media: 'all' });
  }
  const sourceBodyClass = $('body').attr('class') || '';
  const container = $('body');
  container.find('noscript').each((_, element) => $(element).replaceWith($(element).contents()));
  container.find('script,style,link,meta,base,object,embed').remove();
  container.find('*').each((_, element) => {
    const node = $(element);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (/^on/i.test(attribute) || attribute === 'srcdoc') node.removeAttr(attribute);
    }
    if (node.attr('style')) node.attr('style', layout.inline(node.attr('style'), record));
    if (/display\s*:\s*(?:inline-)?flex/i.test(node.attr('style') || '')) node.attr('data-restored-flex', '');
    for (const attribute of ['href', 'src', 'poster']) {
      const raw = node.attr(attribute);
      if (!raw) continue;
      if (/^javascript:/i.test(raw)) { node.removeAttr(attribute); continue; }
      const target = reference(raw, record);
      if (target.unavailable) {
        node.removeAttr(attribute);
      } else {
        node.attr(attribute, target.href);
        if (target.external && attribute === 'href') node.attr('target', '_blank').attr('rel', 'noopener noreferrer');
        if (target.asset?.endsWith('.pdf')) {
          node.attr('type', 'application/pdf').attr('target', '_blank').attr('rel', 'noopener');
          node.attr('data-document', 'pdf');
        }
      }
    }
    for (const attribute of ['srcset', 'data-srcset', 'data-src', 'data-lazy-src']) node.removeAttr(attribute);
    if (element.tagName === 'img') node.attr('loading', 'lazy');
    if (element.tagName === 'iframe') {
      node.attr('loading', 'eager');
      if (!node.attr('referrerpolicy')) node.attr('referrerpolicy', 'strict-origin-when-cross-origin');
    }
  });
  restoreWidgets($, container);
  container.find('table').each((_, element) => {
    $(element).wrap('<div class="archive-table-scroll"></div>');
  });
  container.find('a[data-document="pdf"]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href');
    if (documentLabels.has(href)) return;
    const card = link.closest('li,article,.grop-projct_content_warp,.dlm-card');
    const label = (card.length ? card.text() : link.parent().text()).replace(/\s+/g, ' ').trim();
    if (label) documentLabels.set(href, label);
  });
  const html = container.html() || '';
  const proof = comparePage(sourceHtml, html, record.file);
  textProof.push({ ...proof, stylesheets: stylesheets.length, sourceUnavailable: Boolean(record.unavailable) });
  const bodyText = load(html).text().replace(/\s+/g, ' ').trim();
  const contentFile = `${hash(record.file)}.json`;
  const category = /lawbook/.test(record.file) ? 'law' : /event|venue|장소/.test(record.file) ? 'events'
    : /resource|references|참고|youth/.test(record.file) ? 'resources'
    : /faq/.test(record.file) ? 'faq' : /team|partner|협력/.test(record.file) ? 'partners' : 'pages';
  const page = {
    id: record.file, title, lang, alternate: alt, category,
    source: record.source, contentFile, image,
    excerpt: bodyText.slice(0, 220), searchText: bodyText,
    unavailable: Boolean(record.unavailable),
    canonical: record.old === 'index.html' || record.file.startsWith('en/') || !record.file.includes('__'),
  };
  pages.push(page);
  contents.push({ record, navigation, html, contentFile, stylesheets, sliders, bodyClass: sourceBodyClass });
}
for (const item of contents) {
  fs.writeFileSync(path.join(contentDir, item.contentFile), JSON.stringify({ html: item.html, stylesheets: item.stylesheets, sliders: item.sliders, bodyClass: item.bodyClass }));
}
layout.finish();
for (const record of manifest.files.filter(record => record.kind === 'binary')) {
  const destination = path.join(archiveDir, record.file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, record.file), destination);
}
// Keep the existing archive complete, but avoid listing query-name duplicates in browsing.
const homeIds = { ko: 'index.html', en: 'en/index.html' };
const menus = Object.fromEntries(Object.entries(homeIds).map(([lang, id]) => [
  lang, contents.find(item => item.record.file === id)?.navigation || [],
]));
const documents = manifest.files.filter(record => /\.pdf$/i.test(record.file)).map(record => {
  const href = `./archive/${encoded(record.file)}`;
  return { file: record.file, href, bytes: fs.statSync(path.join(root, record.file)).size, label: documentLabels.get(href) || record.file };
});
fs.writeFileSync(path.join(contentDir, 'search.json'), JSON.stringify(Object.fromEntries(pages.map(page => [page.id, page.searchText]))));
const metadata = pages.map(({ searchText, ...page }) => page);
const catalog = { pages: metadata, menus, homeIds, documents, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(generatedDir, 'catalog.json'), JSON.stringify(catalog));
fs.writeFileSync(path.join(contentDir, 'coverage.json'), JSON.stringify({
  expectedPages: pageRecords.length, generatedPages: pages.length,
  expectedPdfDocuments: manifest.files.filter(record => /\.pdf$/i.test(record.file)).length,
  generatedPdfDocuments: documents.length, copiedAssets: manifest.files.filter(record => record.kind === 'binary').length,
}, null, 2));
console.log(`Prepared ${pages.length}/${pageRecords.length} pages, ${documents.length} PDFs, ${manifest.files.filter(record => record.kind === 'binary').length} local assets.`);
fs.writeFileSync(path.join(contentDir, 'text-parity.json'), JSON.stringify({ pages: textProof.length, exact: textProof.every(item => item.exactText && item.exactLabels), results: textProof }, null, 2));
console.log(`Exact source wording and labels verified for ${textProof.length} pages.`);
