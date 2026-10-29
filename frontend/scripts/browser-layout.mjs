import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { textEvidence } from './text-parity.mjs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(frontend, 'src/generated/catalog.json'), 'utf8'));
const base = process.env.TEST_URL || 'http://127.0.0.1:5173/';
const output = path.join(frontend, 'test-results');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const failures = [];
const representatives = new Set(['index.html', 'index__p=492.html', 'contact.html', 'faq/index.html', 'lawbook.html', 'youth-참고자료/index.html', 'en/index.html', 'events-list/index.html']);
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const queue = [...catalog.pages];
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(base) && !route.request().url().startsWith('data:')) return route.abort();
      return route.continue();
    });
    async function worker() {
      const page = await context.newPage();
      let currentErrors = [];
      page.on('pageerror', error => currentErrors.push(error.message));
      while (queue.length) {
        const entry = queue.shift();
        if (!entry) break;
        currentErrors = [];
        try {
          await page.goto(`${base}#/page?${new URLSearchParams({ file: entry.id })}`, { waitUntil: 'domcontentloaded' });
          const root = page.locator('[data-source-content]');
          await root.waitFor();
          await page.waitForFunction(id => {
            const root = document.querySelector('[data-source-content]');
            return root?.getAttribute('data-page-id') === id && root.getAttribute('aria-busy') === 'false';
          }, entry.id, { timeout: 20000 });
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          });
          const payload = JSON.parse(fs.readFileSync(path.join(frontend, 'public/content', entry.contentFile), 'utf8'));
          const expected = textEvidence(payload.html).text;
          const metrics = await root.evaluate(element => {
            const viewport = document.documentElement.clientWidth;
            const overflow = [...element.querySelectorAll('*')].filter(node => {
              if (!(node instanceof HTMLElement) || node.closest('.archive-table-scroll,image_lists,sr7-slide:not([data-slide-active="true"])')) return false;
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'absolute' || style.position === 'fixed') return false;
              const rect = node.getBoundingClientRect();
              return rect.width > viewport + 8 && rect.height > 0;
            }).slice(0, 8).map(node => ({ tag: node.tagName, class: node.className, width: Math.round(node.getBoundingClientRect().width) }));
            return { text: (element.textContent || '').replace(/\s+/g, ' ').trim(), width: document.documentElement.scrollWidth, viewport, overflow };
          });
          const result = { file: entry.id, viewport: viewport.width, exactText: expected === metrics.text, horizontalOverflow: metrics.width > metrics.viewport + 8, overflow: metrics.overflow, errors: [...currentErrors] };
          results.push(result);
          if (!result.exactText || result.horizontalOverflow || result.errors.length) failures.push(result);
          if (representatives.has(entry.id)) {
            await page.screenshot({ path: path.join(output, `${entry.id.replace(/[\\/=:]/g, '_')}-${viewport.width}.png`), fullPage: false });
          }
        } catch (error) {
          const failure = { file: entry.id, viewport: viewport.width, error: error.message };
          results.push(failure);
          failures.push(failure);
        }
        if (results.length % 100 === 0) console.log(`Rendered ${results.length} page/viewport combinations; failures: ${failures.length}`);
      }
      await page.close();
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(output, 'browser-pages.json'), JSON.stringify({ checked: results.length, failures: failures.length, results }, null, 2));
console.log(JSON.stringify({ checked: results.length, failures: failures.length, firstFailures: failures.slice(0, 12) }, null, 2));
if (failures.length) process.exitCode = 1;
