import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(frontend, 'test-results');
const base = process.env.TEST_URL || 'http://127.0.0.1:5173/';
fs.mkdirSync(output, { recursive: true });

async function open(page, id) {
  await page.goto(`${base}#/page?${new URLSearchParams({ file: id })}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(id => {
    const root = document.querySelector('[data-source-content]');
    return root?.getAttribute('data-page-id') === id && root.getAttribute('aria-busy') === 'false';
  }, id);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.locator('link[data-source-style]').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.sheet)), 'Current page stylesheets must actually be loaded');
}
const activeKey = page => page.locator('sr7-slide[data-slide-active="true"]').getAttribute('data-key');
async function checkStaticContent(page) {
  const unexpected = await page.evaluate(() =>
    [...document.querySelectorAll('#root *')].filter(node => !node.closest('sr7-module')).flatMap(node =>
      [null, '::before', '::after'].flatMap(pseudo => {
        const style = getComputedStyle(node, pseudo);
        return style.animationName !== 'none' || style.transitionDuration.split(',').some(duration => parseFloat(duration) !== 0) ?
          [`${node.tagName}.${node.className}${pseudo || ''}`] : [];
      })));
  assert.deepEqual(unexpected, [], 'No automatic CSS animations or transitions outside the hero');
}

for (const width of [1440, 390]) {
  test(`original hero, video geometry and PDF placeholders at ${width}px`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await page.route('https://**', route => route.abort());
      await open(page, 'index.html');
      await page.locator('.source-hero-arrow').first().waitFor();
      assert.equal(await activeKey(page), '2');
      await page.locator('.sr7-rightarrow').click();
      assert.equal(await activeKey(page), '12');
      await page.locator('.sr7-rightarrow').click();
      assert.equal(await activeKey(page), '1');
      await page.locator('.sr7-rightarrow').click();
      assert.equal(await activeKey(page), '2');
      await page.locator('.sr7-leftarrow').focus();
      await page.keyboard.press('Enter');
      assert.equal(await activeKey(page), '1');
      assert.equal(await page.locator('sr7-slide[inert]').count(), 2);
      assert.equal(await page.locator('sr7-module').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
      const videos = await page.locator('.wpb_video_wrapper iframe').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { src: node.src, title: node.title, policy: node.referrerPolicy, loading: node.loading, width: rect.width, height: rect.height };
      }));
      assert.equal(videos.length, 3);
      for (const [index, video] of videos.entries()) {
        assert.ok(video.src.includes(['gMF3eJzuoyE', 'pir4hr47Bu8', 'xYWOvylw6FE'][index]));
        assert.ok(video.title);
        assert.equal(video.policy, 'strict-origin-when-cross-origin');
        assert.equal(video.loading, 'eager');
        assert.ok(video.width > 250 && video.width <= width);
        assert.ok(Math.abs(video.width / video.height - 16 / 9) < 0.01);
      }
      await page.screenshot({ path: path.join(output, `hero-restored-${width}.png`) });
      await checkStaticContent(page);
      const cta = page.locator('sr7-slide[data-slide-active="true"] > a');
      assert.equal(await cta.textContent(), '법률 책자 보러 가기');
      await cta.click();
      await page.waitForURL(/file=lawbook/);
      await open(page, 'youth-참고자료/index.html');
      await page.locator('.dlm-download-card').first().hover();
      await checkStaticContent(page);
      assert.equal(await page.locator('.dlm-download-card').first().evaluate(node => getComputedStyle(node.parentElement).transform), 'none');
      const placeholders = await page.locator('.dlm-card-placeholder').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(), card = node.closest('.dlm-card-thumbnail').getBoundingClientRect();
        return { width: rect.width, height: rect.height, fontSize: getComputedStyle(node).fontSize,
          centered: Math.abs(rect.x + rect.width / 2 - card.x - card.width / 2) < 1 };
      }));
      assert.equal(placeholders.length, 3);
      for (const placeholder of placeholders) {
        assert.equal(placeholder.width, 180);
        assert.equal(placeholder.height, 180);
        assert.equal(placeholder.fontSize, '128px');
        assert.ok(placeholder.centered);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('.dlm-card-placeholder').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `pdf-cards-restored-${width}.png`) });
    } finally { await browser.close(); }
  });
}

test('iPhone 16 hero and source mobile menu layout, submenus and responsive navigation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, deviceScaleFactor: 3 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**', route => route.abort());
    for (const id of ['index.html', 'en/index.html']) {
      await open(page, id);
      await page.locator('sr7-slide[data-slide-active="true"]').waitFor();
      await page.waitForTimeout(1900);
      const menu = page.locator('#grop-mobil_menu');
      const toggle = page.locator('.collapse-button');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await menu.isVisible(), false);
      const header = await page.locator('.grop-logo.mobile-logo, .collapse-button, .grop-hadr_donate_btn').evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().toJSON()));
      assert.equal(header.length, 3);
      const [logo, contact, button] = header;
      assert.ok(logo.right <= button.left && button.right <= contact.left, 'Original menu sits between logo and contact without overlap');
      assert.ok(contact.right <= 393);
      for (let index = 0; index < 3; index++) {
        const geometry = await page.locator('sr7-slide[data-slide-active="true"]').evaluate(slide => {
          const hero = slide.closest('sr7-module').getBoundingClientRect();
          const img = slide.querySelector('img');
          const text = slide.querySelector('span');
          return {
            hero: hero.toJSON(), image: img.getBoundingClientRect().toJSON(), loaded: img.complete && img.naturalWidth > 0,
            text: text.getBoundingClientRect().toJSON(), opacity: getComputedStyle(text).opacity,
            fit: getComputedStyle(img).objectFit,
          };
        });
        assert.ok(geometry.loaded);
        assert.equal(geometry.fit, 'cover');
        assert.equal(geometry.image.height, geometry.hero.height, 'Photo fills the entire hero, including its lower half');
        assert.equal(geometry.image.width, geometry.hero.width);
        assert.equal(geometry.opacity, '1');
        assert.ok(geometry.text.left >= 40 && geometry.text.right <= 353, 'Caption clears both arrows');
        assert.ok(geometry.text.top >= geometry.hero.top && geometry.text.bottom < geometry.hero.bottom);
        if (index === 0 && id === 'index.html') await page.screenshot({ path: path.join(output, 'iphone16-hero.png'), scale: 'css' });
        await page.locator('.sr7-rightarrow').click();
        await page.waitForTimeout(1900);
      }
      await toggle.click();
      assert.equal(await menu.isVisible(), true);
      assert.equal(await menu.locator(':scope > li').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(17, 17, 17)');
      const bounds = await menu.boundingBox();
      assert.equal(bounds.width, 300);
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 393);
      const submenuToggle = menu.locator('.sub-toggle').first();
      const submenu = page.locator(`[id="${await submenuToggle.getAttribute('aria-controls')}"]`);
      assert.equal(await submenu.isVisible(), false);
      await submenuToggle.click();
      assert.equal(await submenu.isVisible(), true);
      assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'true');
      await submenuToggle.click();
      assert.equal(await submenu.isVisible(), false);
      if (id === 'index.html') await page.screenshot({ path: path.join(output, 'iphone16-menu.png'), scale: 'css' });
      await page.keyboard.press('Escape');
      assert.equal(await menu.isVisible(), false);
      assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
      await toggle.click();
      await page.locator('sr7-module').click({ position: { x: 5, y: 300 } });
      assert.equal(await menu.isVisible(), false);
      await toggle.click();
      await menu.locator(':scope > li > a').first().click();
      await page.waitForFunction(id => document.querySelector('[data-source-content]')?.getAttribute('data-page-id') !== id, id);
      await page.locator('[data-source-content][aria-busy="false"]').waitFor();
      assert.equal(await page.locator('#grop-mobil_menu').isVisible(), false);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [320, 393, 768, 852, 991, 1440]) {
      await page.setViewportSize({ width, height: width === 852 ? 393 : 852 });
      await open(page, 'index.html');
      const toggle = page.locator('.collapse-button');
      assert.equal(await toggle.isVisible(), width <= 991);
      if (width <= 991) {
        await toggle.click();
        const menu = page.locator('#grop-mobil_menu');
        assert.equal(await menu.isVisible(), true);
        const bounds = await menu.boundingBox();
        const header = await page.locator('.grop-header_navigations > .container').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `Entire menu stays inside the viewport at ${width}px`);
        assert.ok(Math.abs(bounds.y - header.y - header.height) < 1, 'Dropdown is anchored below the header, not the icon');
        const link = await menu.locator(':scope > li > a').first().boundingBox();
        assert.ok(link.x >= 0 && link.x + link.width <= width, 'Menu labels are not clipped offscreen');
        await toggle.click();
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No overflow at ${width}px`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('hero runs source animations, cleans up outgoing slides and automatically advances', { timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**', route => route.abort());
    await open(page, 'index.html');
    await page.locator('.sr7-rightarrow').click();
    const motion = await page.locator('sr7-slide[data-slide-active="true"]').evaluate(slide => {
      const text = slide.querySelector('span').getAnimations()[0].effect;
      const background = slide.querySelector('sr7-bg').getAnimations()[0].effect;
      return { text: text.getTiming(), frames: text.getKeyframes(), background: background.getTiming() };
    });
    assert.equal(motion.background.duration, 600);
    assert.equal(motion.text.delay, 300);
    assert.equal(motion.text.duration, 1500);
    assert.equal(motion.frames[0].transform, 'translateY(-50px)');
    assert.ok(motion.text.easing.startsWith('linear('));
    assert.ok(await page.locator('sr7-slide[data-slide-exiting]').count() <= 1);
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('sr7-slide[data-slide-exiting]').count(), 0);
    assert.equal(await page.locator('sr7-slide[data-slide-active="true"] > span').evaluate(node => getComputedStyle(node).opacity), '1');
    await page.locator('.sr7-leftarrow').click();
    await page.locator('.sr7-leftarrow').click();
    assert.equal(await activeKey(page), '1');
    await page.locator('.sr7-rightarrow').click();
    assert.equal(await activeKey(page), '2');
    await page.mouse.move(0, 0);
    await page.locator('.sr7-rightarrow').blur();
    await page.waitForFunction(() => document.querySelector('sr7-slide[data-slide-active="true"]')?.getAttribute('data-key') === '12', undefined, { timeout: 12000 });
    await page.locator('sr7-module').hover();
    await page.waitForTimeout(9500);
    assert.equal(await activeKey(page), '12', 'Original hover pause must stop automatic navigation');
    await checkStaticContent(page);
    await open(page, 'youth-참고자료/index.html');
    assert.equal(await page.locator('.source-hero-arrow').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('FAQ click-only height animation, one-open group, rapid reversal and keyboard support', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('https://**', route => route.abort());
    await open(page, 'faq/index.html');
    const text = await page.locator('[data-source-content]').textContent();
    const questions = page.locator('.grop-faq-single a[data-toggle="collapse"]');
    const first = page.locator('.grop-faq-single .panel-collapse').nth(0);
    const second = page.locator('.grop-faq-single .panel-collapse').nth(1);
    assert.equal(await questions.nth(0).getAttribute('aria-expanded'), 'true');
    assert.equal(await second.getAttribute('aria-hidden'), 'true');
    await questions.nth(1).click();
    const motion = await second.evaluate(node => {
      const effect = node.getAnimations()[0].effect;
      return { timing: effect.getTiming(), frames: effect.getKeyframes() };
    });
    assert.equal(motion.timing.duration, 350);
    assert.equal(motion.timing.easing, 'ease');
    assert.equal(motion.frames[0].height, '0px');
    assert.ok(parseFloat(motion.frames[1].height) > 0);
    await page.waitForTimeout(450);
    assert.equal(await first.getAttribute('aria-hidden'), 'true');
    assert.equal(await second.getAttribute('aria-hidden'), 'false');
    assert.equal(await page.locator('.grop-faq-single .panel-collapse.in').count(), 1);
    await questions.nth(1).click();
    await page.waitForTimeout(100);
    await questions.nth(1).click();
    await page.waitForTimeout(450);
    assert.equal(await second.getAttribute('aria-hidden'), 'false');
    assert.equal(await second.evaluate(node => node.style.height), '');
    assert.equal(await page.locator('[data-faq-animating]').count(), 0);
    await questions.nth(1).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(450);
    assert.equal(await second.getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('[data-source-content]').textContent(), text);
    await checkStaticContent(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await questions.nth(0).click();
    assert.equal(await questions.nth(0).getAttribute('aria-expanded'), 'true');
    assert.equal(await first.evaluate(node => node.getAnimations().length), 0);
    await open(page, 'en/faq-3/index.html');
    const english = page.locator('.grop-faq-single a[data-toggle="collapse"]');
    await english.nth(1).click();
    assert.equal(await english.nth(1).getAttribute('aria-expanded'), 'true');
    assert.equal(await english.nth(0).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-faq-animating]').count(), 0);
  } finally { await browser.close(); }
});
