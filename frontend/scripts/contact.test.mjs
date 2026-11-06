import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const configs = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../backend/config/contact-categories.json', import.meta.url))));
const base = process.env.TEST_URL || 'http://127.0.0.1:5173/';

async function open(page, language) {
  await page.goto(`${base}#/page?${new URLSearchParams({ file: language === 'en' ? 'en/contact.html' : 'contact.html' })}`);
  await page.locator('[data-source-content][aria-busy="false"]').waitFor();
}

for (const language of ['ko', 'en']) {
  for (const width of [1200, 393]) {
  test(`six category-specific forms and waiver-gated legal submission (${language}, ${width}px)`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route('https://**', route => route.abort());
      await page.route('**/api/v1/inquiry-categories', route => route.fulfill({
        json: configs.map(({ slug, name, language, form_id, fields, rules }) => ({ slug, name, language, form_id, fields, rules })),
      }));
      const requests = [];
      await page.route('**/api/v1/inquiries', async route => {
        requests.push({ data: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
        await route.fulfill({ status: 202, json: { id: 'test-reference', status: 'pending' } });
      });
      await open(page, language);
      const selector = page.locator('#menu-service');
      assert.equal(await selector.locator('option').count(), 7);
      for (const config of configs.filter(config => config.language === language)) {
        const category = config.slug.replace(/-(ko|en)$/, '');
        await selector.selectOption(category);
        const box = page.locator(`.grop-contact_form.${category}`);
        assert.equal(await page.locator('.grop-contact_form:visible').count(), 1);
        const form = box.locator('form');
        for (const field of config.fields) {
          assert.equal(await form.locator(`[name="${field.name}"]`).count(), 1);
          if (category === 'contact-3' && ['text-letter', 'text-issue', 'text-type', 'text-schedule', 'text-expect'].includes(field.name)) {
            assert.equal(await form.locator(`[name="${field.name}"]`).getAttribute('placeholder'), field.label);
          }
        }
        assert.equal(await form.locator('button').first().isEnabled(), true);
      }
      const simpleForms = [];
      for (const number of [5, 6]) {
        await selector.selectOption(`contact-${number}`);
        const simple = page.locator(`.grop-contact_form.contact-${number} form`);
        simpleForms.push(await simple.locator('input:not([type="hidden"]):not([type="submit"]), textarea, select, button').evaluateAll(nodes =>
          nodes.map(node => ({
            tag: node.tagName, type: node.getAttribute('type'), name: node.getAttribute('name'),
            placeholder: node.getAttribute('placeholder'), maxlength: node.getAttribute('maxlength'),
            text: node.tagName === 'BUTTON' ? node.textContent?.trim() : null,
            container: node.closest('.grop-confrm_sigl')?.className,
          }))));
        const config = configs.find(config => config.slug === `contact-${number}-${language}`);
        for (const field of config.fields.filter(field => field.type !== 'checkbox')) {
          await simple.locator(`[name="${field.name}"]`).fill(field.type === 'email' ? 'sender@example.org' : 'Test');
        }
        await simple.locator('button[type="submit"]').click();
        assert.equal(requests.length, number - 5, 'Collection consent is required for both categories');
        await simple.locator('[name="acceptance-consent"]').check();
        await simple.locator('button[type="submit"]').click();
        await simple.getByRole('status').last().filter({ hasText: 'test-reference' }).waitFor();
        assert.equal(requests.at(-1).data.category, `contact-${number}-${language}`);
        assert.equal(requests.at(-1).data.fields['acceptance-consent'], true);
      }
      assert.deepEqual(simpleForms[0], simpleForms[1], 'Event/general fields, layout classes and submit button must match');
      requests.length = 0;
      await selector.selectOption('contact-1');
      const form = page.locator('.grop-contact_form.contact-1 form');
      const config = configs.find(config => config.slug === `contact-1-${language}`);
      for (const field of config.fields.filter(field => field.type !== 'checkbox')) {
        await form.locator(`[name="${field.name}"]`).fill(field.type === 'email' ? 'sender@example.org'
          : field.format === 'year' ? '2000' : 'Test');
      }
      await form.locator('.waiver-popup').click();
      const dialog = page.locator('dialog[open]');
      assert.ok(await dialog.textContent().then(text => text.includes(language === 'en' ? 'LT-WOL-001LC/EN' : 'LT-WOL-001LC/KR')));
      await dialog.locator('button').click();
      await form.locator('input[type="submit"]').click();
      assert.equal(requests.length, 0, 'Unchecked consent must prevent submission');
      await form.locator('[name="waiver"]').check();
      await form.locator('input[type="submit"]').click();
      await form.getByRole('status').last().filter({ hasText: 'test-reference' }).waitFor();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].data.category, `contact-1-${language}`);
      assert.equal(requests[0].data.fields.waiver, true);
      assert.equal(requests[0].data.fields['text-name-other-kor'], 'Test');
      assert.match(requests[0].key, /^[0-9a-f-]{36}$/);
      assert.equal(await form.locator('input[type="submit"]').isDisabled(), true);
    } finally {
      await browser.close();
    }
  });
  }
}

test('unconfigured or unavailable categories never enable submission', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**', route => route.abort());
    await page.route('**/api/v1/inquiry-categories', route => route.fulfill({ json: [] }));
    await open(page, 'ko');
    await page.locator('#menu-service').selectOption('contact-1');
    await page.getByText('온라인 문의 접수를 준비 중입니다. 사무실로 문의해 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.contact-1 .waiver-popup').isDisabled(), true);
    await page.route('**/api/v1/inquiry-categories', route => route.fulfill({ status: 503, json: { detail: 'unavailable' } }));
    await page.reload();
    await page.getByText('문의 설정을 불러오지 못했습니다. 페이지를 새로고침하거나 사무실로 문의해 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('.contact-1 .waiver-popup').isDisabled(), true);
  } finally {
    await browser.close();
  }
});

test('network retry reuses idempotency key and does not claim email was sent', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**', route => route.abort());
    await page.route('**/api/v1/inquiry-categories', route => route.fulfill({
      json: configs.map(({ slug, name, language, form_id, fields, rules }) => ({ slug, name, language, form_id, fields, rules })),
    }));
    const keys = [];
    await page.route('**/api/v1/inquiries', async route => {
      keys.push(route.request().headers()['idempotency-key']);
      if (keys.length === 1) await route.abort();
      else await route.fulfill({ status: 202, json: { id: 'retry-reference', status: 'pending' } });
    });

    await open(page, 'ko');
    await page.locator('#menu-service').selectOption('contact-6');
    const form = page.locator('.grop-contact_form.contact-6 form');
    const config = configs.find(config => config.slug === 'contact-6-ko');
    for (const field of config.fields) {
      if (field.type === 'checkbox') await form.locator(`[name="${field.name}"]`).check();
      else await form.locator(`[name="${field.name}"]`).fill(field.type === 'email' ? 'sender@example.org' : 'Test');
    }
    await form.locator('button[type="submit"]').click();
    await form.getByRole('status').last().filter({ hasText: 'Failed to fetch' }).waitFor();
    await form.locator('button[type="submit"]').click();
    const result = form.getByRole('status').last();
    await result.filter({ hasText: 'retry-reference' }).waitFor();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.ok((await result.textContent()).includes('메일 발송 대기'));
  } finally {
    await browser.close();
  }
});

for (const language of ['ko', 'en']) {
  test(`senior self and representative applications have different requirements (${language})`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 393, height: 1000 } });
      await page.route('https://**', route => route.abort());
      await page.route('**/api/v1/inquiry-categories', route => route.fulfill({
        json: configs.map(({ slug, name, language, form_id, fields, rules }) => ({ slug, name, language, form_id, fields, rules })),
      }));
      const requests = [];
      await page.route('**/api/v1/inquiries', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 202, json: { id: 'senior-reference', status: 'pending' } });
      });
      const config = configs.find(config => config.slug === `contact-7-${language}`);
      const rule = config.rules[0];
      async function fillSelf() {
        await open(page, language);
        await page.locator('#menu-service').selectOption('contact-7');
        const form = page.locator('.grop-contact_form.contact-7 form');
        for (const field of config.fields.filter(field => field.required)) {
          const control = form.locator(`[name="${field.name}"]`);
          if (field.type === 'checkbox') await control.check();
          else if (field.type === 'select') await control.selectOption(field.options.find(value => value));
          else await control.fill(field.type === 'email' ? 'sender@example.org'
            : field.format === 'date' ? '1950-01-01' : 'Test');
        }
        return form;
      }
      let form = await fillSelf();
      await form.locator('button[type="submit"]').click();
      await form.getByRole('status').last().filter({ hasText: 'senior-reference' }).waitFor();
      assert.equal(requests.length, 1, 'Self application requires no representative');
      await page.reload();
      form = await fillSelf();
      await form.locator('[name="text-name-other-kor"]').fill('Test Representative');
      await form.locator('button[type="submit"]').click();
      assert.equal(requests.length, 1, 'Incomplete representative details must not submit');
      await form.locator('[name="text-relationship-other"]').fill('Caregiver');
      await form.locator('[name="tel-phone-other"]').fill('4165550100');
      await form.locator('[name="email-address-other"]').fill('representative@example.org');
      await form.locator('[name="menu-consent-other"]').selectOption(language === 'ko' ? '아니오' : 'No');
      await form.locator('button[type="submit"]').click();
      assert.equal(requests.length, 1, 'Declining authorization must not submit');
      await form.locator('[name="menu-consent-other"]').selectOption(rule.consent_value);
      await form.locator('button[type="submit"]').click();
      await form.getByRole('status').last().filter({ hasText: 'senior-reference' }).waitFor();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].fields['text-name-other'], '');
      assert.equal(requests[1].fields['menu-consent-other'], rule.consent_value);
    } finally {
      await browser.close();
    }
  });
}
