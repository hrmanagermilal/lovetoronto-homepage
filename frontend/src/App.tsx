import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import rawCatalog from './generated/catalog.json';
import sharedCss from './site-runtime.css?inline';
import HeroControls from './HeroControls';
import MobileMenu from './MobileMenu';
import type { SliderSettings } from './HeroControls';
import { createFaqController } from './faq';

interface Stylesheet { href: string; media: string }
interface PageContent { html: string; stylesheets: Stylesheet[]; sliders: SliderSettings[]; bodyClass: string }
interface LoadedPage { id: string; version: number; content?: PageContent; error?: string }
const pages = new Map(rawCatalog.pages.map(page => [page.id, page]));

function parseContent(value: unknown): PageContent {
  if (!value || typeof value !== 'object' || !('html' in value) || typeof value.html !== 'string' ||
      !('bodyClass' in value) || typeof value.bodyClass !== 'string' ||
      !('stylesheets' in value) || !Array.isArray(value.stylesheets)) throw new Error('Invalid source page data');
  const stylesheets: Stylesheet[] = value.stylesheets.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('href' in item) || typeof item.href !== 'string' ||
        !item.href.startsWith('./content/styles/') || !('media' in item) || typeof item.media !== 'string') {
      throw new Error('Invalid source stylesheet');
    }
    return { href: item.href, media: item.media };
  });
  if (!('sliders' in value) || !Array.isArray(value.sliders)) throw new Error('Missing source slider settings');
  const sliders: SliderSettings[] = value.sliders.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' ||
        !('arrows' in item) || typeof item.arrows !== 'boolean' ||
        !('arrowClass' in item) || typeof item.arrowClass !== 'string' ||
        !('delay' in item) || typeof item.delay !== 'number' || item.delay <= 0 ||
        !('pauseOnHover' in item) || typeof item.pauseOnHover !== 'boolean' ||
        !('motions' in item) || !Array.isArray(item.motions)) throw new Error('Invalid source slider settings');
    const motions: SliderSettings['motions'] = item.motions.map((motion: unknown) => {
      if (!motion || typeof motion !== 'object' ||
          !('key' in motion) || typeof motion.key !== 'string' ||
          !('backgroundDuration' in motion) || typeof motion.backgroundDuration !== 'number' ||
          !('backgroundEasing' in motion) || typeof motion.backgroundEasing !== 'string' ||
          !('textDelay' in motion) || typeof motion.textDelay !== 'number' ||
          !('textDuration' in motion) || typeof motion.textDuration !== 'number' ||
          !('textEasing' in motion) || typeof motion.textEasing !== 'string' ||
          !('textFromY' in motion) || typeof motion.textFromY !== 'number' ||
          !('textExitDuration' in motion) || typeof motion.textExitDuration !== 'number' ||
          !('textExitEasing' in motion) || typeof motion.textExitEasing !== 'string') throw new Error('Invalid source hero animation');
      return { key: motion.key, backgroundDuration: motion.backgroundDuration, backgroundEasing: motion.backgroundEasing,
        textDelay: motion.textDelay, textDuration: motion.textDuration, textEasing: motion.textEasing,
        textFromY: motion.textFromY, textExitDuration: motion.textExitDuration, textExitEasing: motion.textExitEasing };
    });
    return { id: item.id, arrows: item.arrows, arrowClass: item.arrowClass, delay: item.delay, pauseOnHover: item.pauseOnHover, motions };
  });
  return {
    html: DOMPurify.sanitize(value.html, {
      ADD_TAGS: ['iframe', 'image_lists'],
      ADD_ATTR: ['allowfullscreen', 'allow', 'loading', 'target', 'data-document', 'referrerpolicy'],
      CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^(?:sr7-|image_lists$)/ },
      FORBID_ATTR: ['srcdoc'],
    }),
    stylesheets,
    sliders,
    bodyClass: value.bodyClass,
  };
}

export default function App() {
  const [params] = useSearchParams();
  const pageId = params.get('file') || 'index.html';
  const page = pages.get(pageId);
  const anchor = params.get('anchor');
  const [state, setState] = useState<LoadedPage>({ id: '', version: 0 });
  const [attempt, setAttempt] = useState(0);
  const [loadedStyles, setLoadedStyles] = useState(new Set<string>());
  const [styleError, setStyleError] = useState('');
  const [mobileHost, setMobileHost] = useState<Element | null>(null);
  const [sliderHosts, setSliderHosts] = useState<{ host: Element; settings: SliderSettings }[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const styleVersion = useRef(0);
  const navigate = useNavigate();
  const content = state.id === pageId ? state.content : undefined;
  const pending = !content || content.stylesheets.some((sheet, index) => !loadedStyles.has(`${state.version}:${index}:${sheet.href}`));
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController();
    setStyleError('');
    setMobileHost(null);
    setSliderHosts([]);
    async function load() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}content/${page!.contentFile}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
        const content = parseContent(await response.json());
        if (!controller.signal.aborted) {
          setLoadedStyles(new Set());
          setState({ id: pageId, version: ++styleVersion.current, content });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Source page load failed', pageId, error);
        setState({ id: pageId, version: styleVersion.current, error: error instanceof Error ? error.message : 'Page load failed' });
      }
    }
    void load();
    return () => controller.abort();
  }, [page, pageId, attempt]);
  useEffect(() => {
    if (!content || !page) return;
    document.title = page.title;
    document.documentElement.lang = page.lang === 'en' ? 'en-CA' : 'ko-KR';
    document.body.className = content.bodyClass;
    document.body.dataset.sourcePage = pageId;
    setMobileHost(container.current?.querySelector('.grop-mobil_menu_warp') || null);
    setSliderHosts(content.sliders.flatMap(settings => {
      const host = container.current?.querySelector(`#${CSS.escape(settings.id)}`);
      return host ? [{ host, settings }] : [];
    }));
  }, [content, page, pageId]);
  useEffect(() => {
    if (pending) return;
    if (anchor) {
      const section = container.current?.querySelector(`#${CSS.escape(anchor)}`);
      if (section instanceof HTMLElement) {
        section.classList.add('in', 'vc_active');
        if (section.matches('.grop-faq-single .panel-collapse')) {
          section.inert = false;
          section.setAttribute('aria-hidden', 'false');
          for (const link of container.current?.querySelectorAll('a[aria-controls]') || []) {
            if (link.getAttribute('aria-controls') === section.id) {
              link.setAttribute('aria-expanded', 'true');
              link.classList.remove('collapsed');
            }
          }
        }
        section.scrollIntoView({ block: 'start' });
      }
    } else window.scrollTo(0, 0);
  }, [pending, anchor, pageId]);
  useEffect(() => {
    const root = container.current;
    if (!root || !content) return;
    const faq = createFaqController(root);
    function click(event: MouseEvent) {
      const element = event.target;
      if (!(element instanceof Element)) return;
      const link = element.closest('a');
      if (!link) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const href = link.getAttribute('href');
      const targetId = link.getAttribute('aria-controls');
      const target = targetId ? root!.querySelector(`#${CSS.escape(targetId)}`) : null;
      if (link.matches('[data-toggle="collapse"]') && target) {
        event.preventDefault();
        if (target instanceof HTMLElement && link.closest('.grop-faq-single')) {
          faq.toggle(link, target);
          return;
        }
        target.classList.toggle('in');
        link.setAttribute('aria-expanded', String(target.classList.contains('in')));
        return;
      }
      if (link.closest('.vc_tta-panel-heading,.vc_tta-tabs-list')) {
        const url = href?.startsWith('#/') ? new URL(href.slice(1), 'https://archive.local') : null;
        const id = url?.searchParams.get('anchor') || href?.split('#').at(-1);
        const panel = id ? root!.querySelector(`#${CSS.escape(id)}`) : null;
        if (panel) {
          event.preventDefault();
          if (link.closest('.vc_tta-tabs-list')) {
            for (const sibling of panel.parentElement?.children || []) sibling.classList.toggle('vc_active', sibling === panel);
            for (const item of link.closest('ul')!.children) item.classList.toggle('vc_active', item.contains(link));
          } else panel.classList.toggle('vc_active');
          return;
        }
      }
      const filter = link.getAttribute('data-archive-filter');
      if (filter) {
        event.preventDefault();
        for (const grid of root!.querySelectorAll('[data-restored-grid]')) {
          for (const item of grid.children) {
            if (item instanceof HTMLElement) item.hidden = filter !== '*' && !item.matches(filter);
          }
        }
        return;
      }
      if (href?.startsWith('#/')) {
        const url = new URL(href.slice(1), 'https://archive.local');
        const id = url.searchParams.get('anchor');
        const local = id ? root!.querySelector(`#${CSS.escape(id)}`) : null;
        event.preventDefault();
        if (local) {
          local.scrollIntoView({ block: 'start', behavior: 'instant' });
          return;
        }
        if (id === '0' || id === '') {
          if (link.parentElement?.querySelector('ul')) link.parentElement.classList.toggle('source-menu-expanded');
          return;
        }
        navigate(href.slice(1));
      }
    }
    function submit(event: SubmitEvent) {
      event.preventDefault();
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const search = form.querySelector<HTMLInputElement>('input[name="s"]');
      if (search?.value.trim()) {
        const text = search.value.trim().toLocaleLowerCase();
        const match = rawCatalog.pages.find(item => item.lang === page?.lang && `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(text));
        if (match) navigate(`/page?${new URLSearchParams({ file: match.id })}`);
        else window.alert(page?.lang === 'en' ? 'No results found.' : '검색 결과가 없습니다.');
      } else window.alert(page?.lang === 'en' ? 'Local archive: online submission is unavailable.' : '로컬 보관본에서는 온라인 전송을 할 수 없습니다.');
    }
    root.addEventListener('click', click);
    root.addEventListener('submit', submit);
    function keydown(event: KeyboardEvent) {
      if (event.key === ' ' && event.target instanceof HTMLAnchorElement && event.target.matches('.grop-faq-single a[data-toggle="collapse"]')) {
        event.preventDefault();
        event.target.click();
      }
    }
    root.addEventListener('keydown', keydown);
    return () => {
      faq.dispose();
      root.removeEventListener('click', click);
      root.removeEventListener('submit', submit);
      root.removeEventListener('keydown', keydown);
    };
  }, [content, navigate, page?.lang]);
  if (!page) return <p role="alert">Page not found: {pageId}</p>;
  if (state.id === pageId && state.error) return <section role="alert"><p>{state.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></section>;
  return <>
    {content && createPortal(<>
      {content.stylesheets.map((sheet, index) => <link key={`${state.version}:${index}:${sheet.href}`} data-source-style rel="stylesheet" href={sheet.href} media={sheet.media}
        onLoad={() => setLoadedStyles(previous => new Set(previous).add(`${state.version}:${index}:${sheet.href}`))}
        onError={() => { console.error('Source stylesheet failed', sheet.href); setStyleError(sheet.href); }} />)}
      <style data-source-runtime>{sharedCss}</style>
    </>, document.head)}
    {styleError && <p role="alert">Stylesheet load failed: {styleError}</p>}
    <div ref={container} data-source-content data-page-id={pageId} aria-busy={pending}
      style={{ visibility: pending && !styleError ? 'hidden' : 'visible' }} dangerouslySetInnerHTML={{ __html: content?.html || '' }} />
    {mobileHost && <MobileMenu key={pageId} host={mobileHost} language={page.lang} />}
    {!pending && sliderHosts.map(({ settings, host }) => <HeroControls key={`${pageId}:${settings.id}`} settings={settings} host={host} language={page.lang} />)}
  </>;
}
