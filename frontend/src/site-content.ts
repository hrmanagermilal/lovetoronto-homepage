// Content managed on the admin site (port 81). Only the port-84 proxy routes
// /api/v1/site/; elsewhere the request fails and the archived page is unchanged.
import type { Language } from './types';

export interface SiteSlide { image: string; alt: string; title: string; buttonLabel: string; buttonUrl: string; newTab: boolean }
export interface SiteNewsletter { title: string; file: string; thumbnail: string; date: string; kind: 'pdf' | 'link' }
export interface SiteContent { hero: Record<Language, SiteSlide[]>; newsletters: SiteNewsletter[] }

const ARCHIVE = String.raw`archive/[A-Za-z0-9._~%/()+,-]+`;
const IMAGE = new RegExp(String.raw`^/(?:media/hero/[0-9a-f]{32}\.(?:jpg|png)|${ARCHIVE})$`);
const PDF = new RegExp(String.raw`^/(?:media/newsletters/[0-9a-f]{32}\.pdf|${ARCHIVE}\.pdf)$`, 'i');
const THUMBNAIL = /^\/media\/thumbs\/[0-9a-f]{32}\.(?:jpg|png)$/;
const LINK = /^(?:https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/\S*)?|#\/page\?\S+)$/;
// Archived newsletter list pages; on port 84 their list is rebuilt from the database.
export const NEWSLETTER_PAGES = new Set([
  'index__p=3061.html', 'news/index.html', 'news/page/1/index.html', 'news/page/2/index.html',
  'news/page/3/index.html', 'index__p=3926.html', 'en/news/index.html',
]);
const NEWSLETTER_HOME: Record<Language, string> = { ko: 'news/index.html', en: 'en/news/index.html' };
export const NEWSLETTERS_PER_PAGE = 9;

const text = (value: unknown) => typeof value === 'string' ? value : '';
const safePath = (value: string) => !value.split('/').includes('..');

function parse(value: unknown): SiteContent | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as { hero?: Record<string, unknown>; newsletters?: unknown };
  const slides = (items: unknown): SiteSlide[] => (Array.isArray(items) ? items : []).flatMap(item => {
    const slide = {
      image: text(item?.image), alt: text(item?.alt), title: text(item?.title),
      buttonLabel: text(item?.buttonLabel), buttonUrl: text(item?.buttonUrl), newTab: item?.newTab === true,
    };
    if (!IMAGE.test(slide.image) || !safePath(slide.image)) return [];
    if (slide.buttonUrl && !LINK.test(slide.buttonUrl)) slide.buttonUrl = '';
    return [slide];
  });
  const newsletters = (Array.isArray(data.newsletters) ? data.newsletters : []).flatMap(item => {
    const entry: SiteNewsletter = {
      title: text(item?.title), file: text(item?.file), thumbnail: text(item?.thumbnail), date: text(item?.date),
      kind: PDF.test(text(item?.file)) ? 'pdf' : 'link',
    };
    const valid = entry.kind === 'pdf' ? safePath(entry.file) : entry.file.startsWith('https://') && LINK.test(entry.file);
    if (!entry.title || !valid) return [];
    if (!THUMBNAIL.test(entry.thumbnail)) entry.thumbnail = '';
    return [entry];
  });
  return { hero: { ko: slides(data.hero?.ko), en: slides(data.hero?.en) }, newsletters };
}

let request: Promise<SiteContent | null> | undefined;

export function loadSiteContent(): Promise<SiteContent | null> {
  request ??= fetch('/api/v1/site/content', { headers: { Accept: 'application/json' } })
    .then(response => response.ok ? response.json() : null)
    .then(parse)
    .catch(() => null);
  return request;
}

export function applySiteContent(html: string, site: SiteContent, options: {
  pageId: string; language: Language; home: boolean; slider?: { id: string; motionKey?: string }; listPage?: number;
}): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  // Elements are created in the template's inert document so images do not load before rendering.
  const doc = template.content.ownerDocument;
  const create = <K extends string>(tag: K, className = '') => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    return element;
  };
  let changed = false;

  const slides = site.hero[options.language];
  const slider = options.slider;
  if (options.home && slider?.motionKey && slides.length) {
    const target = template.content.querySelector(`#${CSS.escape(slider.id)} sr7-content`);
    if (target) {
      target.replaceChildren(...slides.map((slide, index) => {
        const element = create('sr7-slide');
        element.id = `${slider.id}-site${index + 1}`;
        element.setAttribute('data-key', slider.motionKey!);
        const background = create('sr7-bg', 'sr7-layer');
        const image = create('img');
        image.setAttribute('src', slide.image);
        image.setAttribute('alt', slide.alt);
        image.setAttribute('loading', index === 0 ? 'eager' : 'lazy');
        background.append(image);
        element.append(background);
        if (slide.title) {
          const caption = create('span', 'sr7-layer');
          slide.title.split('\n').forEach((line, lineIndex) => {
            if (lineIndex) caption.append(create('br'));
            caption.append(line);
          });
          element.append(caption);
        }
        if (slide.buttonLabel && slide.buttonUrl) {
          const link = create('a', 'sr7-layer');
          link.setAttribute('href', slide.buttonUrl);
          link.setAttribute('target', slide.newTab ? '_blank' : '_self');
          link.setAttribute('rel', slide.newTab ? 'noopener noreferrer' : 'nofollow');
          link.textContent = slide.buttonLabel;
          element.append(link);
        }
        return element;
      }));
      changed = true;
    }
  }

  if (NEWSLETTER_PAGES.has(options.pageId)) {
    const list = template.content.querySelector('ul.dlm-downloads');
    const sample = list?.querySelector(':scope > li');
    if (list && sample?.querySelector('a.dlm-card-btn') && sample.querySelector('.dlm-card-desc') && sample.querySelector('.dlm-card-thumbnail')) {
      const pages = Math.max(1, Math.ceil(site.newsletters.length / NEWSLETTERS_PER_PAGE));
      const archivedPage = Number(/^news\/page\/(\d+)\//.exec(options.pageId)?.[1] || 1);
      const current = Math.min(pages, Math.max(1, options.listPage || archivedPage));
      const items = site.newsletters.slice((current - 1) * NEWSLETTERS_PER_PAGE, current * NEWSLETTERS_PER_PAGE);
      list.replaceChildren(...items.map(item => {
        const card = sample.cloneNode(true) as Element;
        card.setAttribute('data-site-newsletter', item.date);
        const strong = create('strong');
        const paragraph = create('p');
        paragraph.textContent = item.title;
        strong.append(paragraph);
        card.querySelector('.dlm-card-desc')!.replaceChildren(strong);
        let cover: Element;
        if (item.thumbnail) {
          cover = create('img');
          cover.setAttribute('src', item.thumbnail);
          cover.setAttribute('alt', '');
          cover.setAttribute('loading', 'lazy');
          cover.setAttribute('data-site-thumbnail', '');
        } else {
          cover = create('div', 'dlm-card-placeholder');
          cover.textContent = item.kind === 'pdf' ? '📄' : '🎬';
        }
        card.querySelector('.dlm-card-thumbnail')!.replaceChildren(cover);
        const link = card.querySelector('a.dlm-card-btn')!;
        link.setAttribute('href', item.file);
        link.setAttribute('target', '_blank');
        link.removeAttribute('title');
        if (item.kind === 'pdf') {
          link.setAttribute('rel', 'noopener');
          link.setAttribute('type', 'application/pdf');
          link.setAttribute('data-document', 'pdf');
        } else {
          link.setAttribute('rel', 'noopener noreferrer');
          link.removeAttribute('type');
          link.removeAttribute('data-document');
        }
        return card;
      }));

      let nav = template.content.querySelector('nav.dlm-download-monitor-pagination');
      if (pages < 2) nav?.remove();
      else {
        if (!nav) {
          nav = create('nav', 'dlm-download-monitor-pagination');
          list.after(nav);
        }
        const numbers = create('ul', 'page-numbers');
        const href = (page: number) => `#/page?${new URLSearchParams({ file: NEWSLETTER_HOME[options.language], p: String(page) })}`;
        const item = (page: number, label: string, className = '') => {
          const entry = create('li');
          const link = create('a', `${className} page-numbers`.trim());
          link.setAttribute('href', href(page));
          link.textContent = label;
          entry.append(link);
          return entry;
        };
        if (current > 1) numbers.append(item(current - 1, '←', 'prev'));
        for (let page = 1; page <= pages; page++) {
          if (page === current) {
            const entry = create('li');
            const span = create('span', 'page-numbers current');
            span.setAttribute('aria-current', 'page');
            span.textContent = String(page);
            entry.append(span);
            numbers.append(entry);
          } else numbers.append(item(page, String(page)));
        }
        if (current < pages) numbers.append(item(current + 1, '→', 'next'));
        nav.replaceChildren(numbers);
      }
      changed = true;
    }
  }
  return changed ? template.innerHTML : html;
}
