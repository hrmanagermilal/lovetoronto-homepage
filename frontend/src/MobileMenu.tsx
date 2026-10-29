import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function MobileMenu({ host, language }: { host: Element; language: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [menu] = useState(() => host.querySelector<HTMLUListElement>('#grop-mobil_menu'));
  const [groups] = useState(() => [...host.querySelectorAll<HTMLLIElement>('li')].flatMap(item => {
    const submenu = item.querySelector<HTMLUListElement>(':scope > ul');
    const link = item.querySelector<HTMLAnchorElement>(':scope > a');
    return submenu && link ? [{ item, submenu, label: link.textContent?.trim() || '', id: `${item.id}-submenu` }] : [];
  }));
  useEffect(() => {
    if (!menu) return;
    menu.classList.add('collapsed');
    for (const group of groups) group.submenu.id = group.id;
    return () => {
      menu.classList.remove('collapsed');
      for (const group of groups) group.submenu.removeAttribute('id');
    };
  }, [menu, groups]);
  useEffect(() => {
    if (!menu) return;
    menu.hidden = !open;
    for (const group of groups) group.item.classList.toggle('source-menu-expanded', open && expanded.includes(group.id));
  }, [menu, groups, open, expanded]);
  useEffect(() => {
    const close = () => { setOpen(false); setExpanded([]); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        close();
        host.querySelector<HTMLButtonElement>('.collapse-button')?.focus();
      }
    };
    const navigate = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('a')) close();
    };
    const desktop = matchMedia('(min-width: 992px)');
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    host.addEventListener('click', navigate);
    desktop.addEventListener('change', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      host.removeEventListener('click', navigate);
      desktop.removeEventListener('change', close);
    };
  }, [host, open]);
  if (!menu) return null;
  return <>
    {createPortal(<div className="menu-collapser">
      <button type="button" className={`collapse-button${open ? ' grop-mobil_menu-visible' : ''}`}
        aria-label={language === 'en' ? (open ? 'Close menu' : 'Open menu') : (open ? '메뉴 닫기' : '메뉴 열기')}
        aria-controls={menu.id} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="icon-bar" /><span className="icon-bar" /><span className="icon-bar" />
      </button>
    </div>, host)}
    {groups.map(group => createPortal(<button type="button" className="sub-toggle"
      aria-label={group.label} aria-controls={group.id} aria-expanded={expanded.includes(group.id)}
      onClick={() => setExpanded(value => value.includes(group.id) ? value.filter(id => id !== group.id) : [...value, group.id])}>
      <i aria-hidden="true">{expanded.includes(group.id) ? '-' : '+'}</i>
    </button>, group.item, group.id))}
  </>;
}
