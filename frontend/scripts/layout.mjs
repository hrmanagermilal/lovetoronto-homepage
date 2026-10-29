import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import postcss from 'postcss';

export function createLayoutWriter({ root, archiveDir, contentDir, reference }) {
  const directory = path.join(contentDir, 'styles');
  fs.mkdirSync(directory, { recursive: true });
  const cache = new Map();
  const fonts = new Set();
  function inline(css, record, stylesheet = false) {
    if (/expression\s*\(|url\(\s*["']?\s*javascript\s*:|-moz-binding|(?:^|[;{])\s*behavior\s*:/i.test(css)) {
      throw new Error(`Unsafe legacy CSS in ${record.file}`);
    }
    return css.replace(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi, (_, quote, quoted, bare) => {
      const raw = (quoted ?? bare).trim().replace(/&quot;/g, '"').replace(/^["']|["']$/g, '');
      if (!raw || raw.startsWith('#') || raw.startsWith('data:')) return `url("${raw}")`;
      const target = reference(raw, record);
      if (!target.href) throw new Error(`Missing CSS asset in ${record.file}: ${raw}`);
      const href = stylesheet && target.asset ? `../../archive/${encodeURI(target.asset).replace(/#/g, '%23').replace(/\?/g, '%3F')}${raw.includes('#') ? `#${raw.split('#')[1]}` : ''}` : target.href;
      return `url("${href.replace(/"/g, '%22')}")`;
    });
  }
  function write(css, record) {
    const key = `${record.file}\0${css}`;
    if (cache.has(key)) return cache.get(key);
    const ast = postcss.parse(inline(css, record, true), { from: record.file });
    ast.walkAtRules('font-face', rule => {
      fonts.add(rule.toString().replace(/\.\.\/\.\.\/archive\//g, '../archive/'));
    });
    ast.walkAtRules('import', rule => {
      // All downloaded site CSS uses URL imports or local link tags, not executable loaders.
      if (!/^(?:url\(|["'])/.test(rule.params)) throw new Error(`Unsupported CSS import in ${record.file}`);
    });
    const output = ast.toString();
    const filename = `${crypto.createHash('sha256').update(output).digest('hex').slice(0, 20)}.css`;
    fs.writeFileSync(path.join(directory, filename), output);
    const href = `./content/styles/${filename}`;
    cache.set(key, href);
    return href;
  }
  function pageStyles($, record) {
    const result = [];
    $('link[rel="stylesheet"],style').each((_, element) => {
      const node = $(element);
      if (element.tagName === 'style') {
        const text = node.text();
        if (text.trim()) result.push({ href: write(text, record), media: node.attr('media') || 'all' });
      } else {
        const target = reference(node.attr('href'), record);
        if (!target.asset) throw new Error(`Stylesheet is not local: ${record.file}: ${node.attr('href')}`);
        const stylesheetRecord = { ...record, file: target.asset };
        const original = path.join(root, target.asset);
        const css = fs.readFileSync(fs.existsSync(original) ? original : path.join(archiveDir, target.asset), 'utf8');
        result.push({ href: write(css, stylesheetRecord), media: node.attr('media') || 'all' });
      }
    });
    return result;
  }
  return {
    inline,
    write,
    pageStyles,
    finish() { fs.writeFileSync(path.join(contentDir, 'fonts.css'), [...fonts].join('\n')); },
  };
}

export function restoreWidgets($, container) {
  container.find('.owl-carousel,.wpb_images_carousel,.vc_images_carousel').each((_, element) => {
    const node = $(element);
    node.attr('data-restored-gallery', '');
  });
  container.find('.grop-filter_content,.grop-projctfilter_content').attr('data-restored-grid', '');
  container.find('.grop-fltr_nav [data-filter]').each((_, element) => {
    const link = $(element);
    link.attr('data-archive-filter', link.attr('data-filter') || '*');
    link.attr('role', 'button').attr('aria-pressed', link.hasClass('active') ? 'true' : 'false');
  });
  container.find('form').each((_, element) => {
    const form = $(element);
    form.removeAttr('action').removeAttr('method');
    form.find('button,input[type=submit]').attr('disabled', 'disabled');
  });
}
