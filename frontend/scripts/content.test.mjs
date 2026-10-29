import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { comparePage, textEvidence } from './text-parity.mjs';
import { sourceSliders } from './sliders.mjs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.ARCHIVE_ROOT ? path.resolve(process.env.ARCHIVE_ROOT) : null;
const coverage = JSON.parse(fs.readFileSync(path.join(frontend, 'public/content/coverage.json'), 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(frontend, 'public/content/text-parity.json'), 'utf8'));
const proofs = new Map(evidence.results.map(item => [item.file, item]));
const catalog = JSON.parse(fs.readFileSync(path.join(frontend, 'src', 'generated', 'catalog.json'), 'utf8'));
const pages = new Map(catalog.pages.map(page => [page.id, page]));
const read = page => JSON.parse(fs.readFileSync(path.join(frontend, 'public', 'content', page.contentFile), 'utf8')).html;
const resolveAsset = href => path.join(frontend, 'public', decodeURIComponent(href.replace(/^\.\//, '').split('#')[0]));

test('every archived HTML page is available in the React content catalog', () => {
  assert.equal(catalog.pages.length, coverage.expectedPages);
  assert.equal(catalog.pages.length, coverage.generatedPages);
  assert.equal(catalog.pages.length, proofs.size);
  for (const page of catalog.pages) {
    assert.ok(read(page).trim().length, page.id);
    assert.ok(['en', 'ko'].includes(page.lang), page.id);
  }
});

test('all migrated links, images, posters and PDFs resolve locally or are explicitly external', () => {
  for (const page of catalog.pages) {
    const $ = load(read(page));
    $('[href],[src],[poster]').each((_, element) => {
      for (const attribute of ['href', 'src', 'poster']) {
        const href = $(element).attr(attribute);
        if (!href || /^(?:https?:|mailto:|tel:|data:|webcal:)/i.test(href)) continue;
        if (href.startsWith('#/page?')) {
          const id = new URLSearchParams(href.split('?')[1]).get('file');
          assert.ok(pages.has(id), `${page.id}: missing page ${id}`);
        } else if (href.startsWith('./archive/')) {
          assert.ok(fs.existsSync(resolveAsset(href)), `${page.id}: missing asset ${href}`);
        } else {
          assert.fail(`${page.id}: unexpected local reference ${href}`);
        }
      }
    });
  }
});

test('language alternates and English menus lead to the requested language', () => {
  for (const page of catalog.pages) {
    for (const [language, id] of Object.entries(page.alternate)) {
      assert.equal(pages.get(id)?.lang, language, `${page.id}: ${language} -> ${id}`);
    }
  }
  function check(items, language) {
    assert.ok(items.length > 0);
    for (const item of items) {
      if (item.href?.startsWith('#/page?')) {
        const id = new URLSearchParams(item.href.split('?')[1]).get('file');
        assert.equal(pages.get(id)?.lang, language, `${language} menu ${item.label}`);
      }
      if (item.children.length) check(item.children, language);
    }
  }
  check(catalog.menus.en, 'en');
  check(catalog.menus.ko, 'ko');
  assert.equal(pages.get('index__p=3298.html').alternate.en, 'index__p=4009.html');
  assert.equal(pages.get('index__p=4009.html').lang, 'en');
});

test('all generated PDFs match recorded byte counts and youth details link to PDF files', () => {
  assert.equal(catalog.documents.length, coverage.expectedPdfDocuments);
  for (const document of catalog.documents) {
    const copy = fs.readFileSync(path.join(frontend, 'public', 'archive', document.file));
    assert.equal(copy.length, document.bytes, document.file);
    assert.equal(copy.subarray(0, 5).toString(), '%PDF-');
    assert.ok(copy.subarray(-1024).includes(Buffer.from('%%EOF')), document.file);
  }
  const $ = load(read(pages.get('youth-참고자료/index.html')));
  for (const id of ['3105', '3120', '3122']) {
    assert.equal($(`a[href="./archive/download/${id}/document.pdf"]`).length, 1);
  }
});

test('archived executable scripts and form submissions are not retained', () => {
  for (const page of catalog.pages) {
    const $ = load(read(page));
    assert.equal($('script,object,embed,base').length, 0, page.id);
    $('*').each((_, element) => {
      for (const attribute of Object.keys(element.attribs || {})) assert.ok(!/^on/i.test(attribute), `${page.id}: ${attribute}`);
    });
    $('form').each((_, element) => {
      assert.equal($(element).attr('action'), undefined, page.id);
      $(element).find('button,input[type=submit]').each((_, button) => assert.notEqual($(button).attr('disabled'), undefined, page.id));
    });
  }
});

test('every page matches saved source wording and label hashes and includes shared source CSS', () => {
  const cssPaths = new Set();
  let totalStyles = 0;
  for (const page of catalog.pages) {
    const data = JSON.parse(fs.readFileSync(path.join(frontend, 'public', 'content', page.contentFile), 'utf8'));
    const proof = proofs.get(page.id);
    assert.ok(proof?.exactText && proof.exactLabels, page.id);
    const current = textEvidence(data.html);
    assert.equal(current.textSha256, proof.textSha256, `${page.id}: text`);
    assert.equal(current.attributeSha256, proof.attributeSha256, `${page.id}: labels`);
    assert.equal(data.stylesheets.length, proof.stylesheets, `${page.id}: stylesheets`);
    assert.equal(typeof data.bodyClass, 'string', page.id);
    assert.ok(Array.isArray(data.sliders), page.id);
    for (const stylesheet of data.stylesheets) {
      assert.ok(fs.existsSync(resolveAsset(stylesheet.href)), `${page.id}: ${stylesheet.href}`);
      cssPaths.add(stylesheet.href);
      totalStyles++;
    }
  }
  assert.ok(cssPaths.size < totalStyles / 10, 'Shared source CSS must be reused, not duplicated for every page');
});

test('optional original archive comparison: text, styles, slider settings and PDF bytes',
  { skip: !root && 'Set ARCHIVE_ROOT to compare against the original downloaded files' }, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'offline-manifest.json'), 'utf8'));
    assert.equal(catalog.pages.length, manifest.files.filter(item => item.kind === 'html').length);
    for (const page of catalog.pages) {
      const source = fs.readFileSync(path.join(root, page.id), 'utf8');
      const data = JSON.parse(fs.readFileSync(path.join(frontend, 'public/content', page.contentFile), 'utf8'));
      comparePage(source, data.html, page.id);
      assert.deepEqual(data.sliders, sourceSliders(source), page.id);
      assert.equal(data.bodyClass, load(source, { scriptingEnabled: false })('body').attr('class') || '', page.id);
    }
    for (const document of catalog.documents) {
      assert.ok(fs.readFileSync(path.join(root, document.file)).equals(fs.readFileSync(path.join(frontend, 'public/archive', document.file))), document.file);
    }
  });

test('hero motion uses original fade, caption reveal and automatic playback timings', () => {
  const [slider] = JSON.parse(fs.readFileSync(path.join(frontend, 'public/content', pages.get('index.html').contentFile), 'utf8')).sliders;
  assert.equal(slider.delay, 9000);
  assert.equal(slider.pauseOnHover, true);
  assert.equal(slider.arrows, true);
  assert.ok(slider.arrowCss.includes('width:60px'));
  assert.equal(slider.motions.length, 3);
  for (const motion of slider.motions) {
    assert.equal(motion.backgroundDuration, 600);
    assert.equal(motion.backgroundEasing, 'power2.inOut');
    assert.equal(motion.textDelay, 300);
    assert.equal(motion.textDuration, 1500);
    assert.equal(motion.textEasing, 'back.inOut');
    assert.equal(motion.textFromY, -50);
    assert.equal(motion.textExitDuration, 300);
  }
});

test('MUI and invented marketing content are not part of the frontend', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) assert.ok(!/^@(?:mui|emotion)\//.test(dependency));
  const app = fs.readFileSync(path.join(frontend, 'src', 'App.tsx'), 'utf8');
  assert.ok(!app.includes('@mui/'));
});
