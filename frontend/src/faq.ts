export function createFaqController(root: HTMLElement) {
  const running = new Map<HTMLElement, { animation: Animation; open: boolean; restore: () => void }>();
  const links = [...root.querySelectorAll<HTMLAnchorElement>('.grop-faq-single a[data-toggle="collapse"][aria-controls]')];
  const panelFor = (link: HTMLAnchorElement) => root.querySelector<HTMLElement>(`#${CSS.escape(link.getAttribute('aria-controls')!)}`);
  function updateState(link: HTMLAnchorElement, panel: HTMLElement, open: boolean) {
    link.setAttribute('aria-expanded', String(open));
    link.classList.toggle('collapsed', !open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
  }
  for (const link of links) {
    const panel = panelFor(link);
    if (panel) updateState(link, panel, panel.classList.contains('in'));
  }
  function setOpen(link: HTMLAnchorElement, panel: HTMLElement, open: boolean) {
    const height = panel.getBoundingClientRect().height;
    const previous = running.get(panel);
    if (previous) {
      previous.animation.onfinish = null;
      previous.animation.cancel();
      previous.restore();
      running.delete(panel);
    }
    updateState(link, panel, open);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      panel.classList.toggle('in', open);
      return;
    }
    panel.classList.add('in');
    const end = open ? panel.getBoundingClientRect().height : 0;
    const overflow = panel.style.getPropertyValue('overflow');
    const priority = panel.style.getPropertyPriority('overflow');
    panel.style.overflow = 'hidden';
    panel.setAttribute('data-faq-animating', '');
    const restore = () => {
      if (overflow) panel.style.setProperty('overflow', overflow, priority);
      else panel.style.removeProperty('overflow');
      panel.removeAttribute('data-faq-animating');
    };
    const animation = panel.animate([{ height: `${height}px` }, { height: `${end}px` }], {
      duration: 350, easing: 'ease', fill: 'both',
    });
    running.set(panel, { animation, open, restore });
    animation.onfinish = () => {
      panel.classList.toggle('in', open);
      animation.cancel();
      restore();
      running.delete(panel);
    };
  }
  return {
    toggle(link: HTMLAnchorElement, panel: HTMLElement) {
      const open = !(running.get(panel)?.open ?? panel.classList.contains('in'));
      const group = link.getAttribute('data-parent');
      if (open && group) {
        for (const siblingLink of links) {
          if (siblingLink === link || siblingLink.getAttribute('data-parent') !== group) continue;
          const sibling = panelFor(siblingLink);
          if (sibling && (running.get(sibling)?.open ?? sibling.classList.contains('in'))) setOpen(siblingLink, sibling, false);
        }
      }
      setOpen(link, panel, open);
    },
    dispose() {
      for (const { animation, restore } of running.values()) {
        animation.onfinish = null;
        animation.cancel();
        restore();
      }
      running.clear();
    },
  };
}
