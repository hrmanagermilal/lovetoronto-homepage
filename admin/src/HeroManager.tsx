import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText, Slide, upload } from './api';

type Language = 'ko' | 'en';
type Draft = Omit<Slide, 'id' | 'language' | 'position'>;
const EMPTY: Draft = { image_url: '', alt: '', title: '', button_label: '', button_url: '', new_tab: false, active: true };

function SlideForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: Draft; submitLabel: string; onSubmit: (draft: Draft) => Promise<void>; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));

  async function chooseImage(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try { set('image_url', await upload('hero', file)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.image_url) { setError('이미지를 선택하십시오.'); return; }
    setBusy(true); setError('');
    try { await onSubmit(draft); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <form className="slide-form" onSubmit={submit}>
    <div className="preview">
      {draft.image_url ? <img src={draft.image_url} alt="" /> : <span>이미지 없음</span>}
      {draft.title && <span className="overlay">{draft.title}</span>}
    </div>
    <div className="fields">
      <label>이미지 (JPG/PNG/WebP, 최대 20MB · 가로 1920px 이상 권장)
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => chooseImage(e.target.files?.[0])} />
      </label>
      <label>문구 (최대 4줄)<textarea rows={2} maxLength={300} value={draft.title} onChange={e => set('title', e.target.value)} /></label>
      <label>이미지 설명 (alt, 선택)<input maxLength={200} value={draft.alt} onChange={e => set('alt', e.target.value)} /></label>
      <div className="row">
        <label>버튼 문구 (선택)<input maxLength={100} value={draft.button_label} onChange={e => set('button_label', e.target.value)} /></label>
        <label>버튼 링크<input maxLength={500} placeholder="https://… 또는 #/page?file=…" value={draft.button_url} onChange={e => set('button_url', e.target.value)} /></label>
      </div>
      <div className="row checks">
        <label className="check"><input type="checkbox" checked={draft.new_tab} onChange={e => set('new_tab', e.target.checked)} />새 탭에서 열기</label>
        <label className="check"><input type="checkbox" checked={draft.active} onChange={e => set('active', e.target.checked)} />홈페이지에 표시</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button disabled={busy}>{busy ? '처리 중…' : submitLabel}</button>
        {onCancel && <button type="button" className="secondary" onClick={onCancel}>취소</button>}
      </div>
    </div>
  </form>;
}

export default function HeroManager() {
  const [language, setLanguage] = useState<Language>('ko');
  const [slides, setSlides] = useState<Slide[]>([]);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<Slide[]>(`/hero?language=${language}`).then(setSlides).catch(e => setError(errorText(e)));
  }, [language]);
  useEffect(() => { setEditing(null); setError(''); load(); }, [load]);

  async function move(index: number, offset: number) {
    const ids = slides.map(slide => slide.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    try { setSlides(await api<Slide[]>('/hero/order', { json: { language, ids } })); } catch (e) { setError(errorText(e)); load(); }
  }
  async function remove(slide: Slide) {
    if (!confirm(`이 슬라이드를 삭제할까요?\n${slide.title || slide.image_url}`)) return;
    try { await api(`/hero/${slide.id}`, { method: 'DELETE' }); load(); } catch (e) { setError(errorText(e)); }
  }

  return <section>
    <h2>Hero 이미지 (첫 화면 슬라이드)</h2>
    <p className="muted">표시 순서대로 슬라이드가 자동 전환됩니다. 변경 사항은 저장 즉시 84번 포트의 새 홈페이지에 반영됩니다.
      표시할 슬라이드가 하나도 없으면 기존 보관본 슬라이드가 나옵니다.</p>
    <div className="tabs" role="tablist">
      {(['ko', 'en'] as const).map(item => <button key={item} role="tab" aria-selected={language === item}
        className={language === item ? 'selected' : 'secondary'} onClick={() => setLanguage(item)}>{item === 'ko' ? '한국어 홈' : 'English home'}</button>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <ol className="slides">
      {slides.map((slide, index) => <li key={slide.id} className={slide.active ? '' : 'inactive'}>
        {editing === slide.id ? <SlideForm initial={slide} submitLabel="저장" onCancel={() => setEditing(null)}
          onSubmit={async draft => { await api(`/hero/${slide.id}`, { method: 'PATCH', json: draft }); setEditing(null); load(); }} /> :
          <div className="slide-row">
            <img src={slide.image_url} alt="" />
            <div className="slide-text">
              <strong>{slide.title.split('\n').map((line, i) => <span key={i}>{line}<br /></span>)}</strong>
              {slide.button_label && <span className="muted">버튼: {slide.button_label} → {slide.button_url}</span>}
              {!slide.active && <span className="badge">숨김</span>}
            </div>
            <div className="actions">
              <button className="secondary" disabled={index === 0} onClick={() => move(index, -1)} aria-label="위로">↑</button>
              <button className="secondary" disabled={index === slides.length - 1} onClick={() => move(index, 1)} aria-label="아래로">↓</button>
              <button onClick={() => setEditing(slide.id)}>수정</button>
              <button className="danger" onClick={() => remove(slide)}>삭제</button>
            </div>
          </div>}
      </li>)}
    </ol>
    {editing === 'new' ? <div className="card">
      <h3>새 슬라이드</h3>
      <SlideForm initial={EMPTY} submitLabel="추가" onCancel={() => setEditing(null)}
        onSubmit={async draft => { await api('/hero', { json: { ...draft, language } }); setEditing(null); load(); }} />
    </div> : <button onClick={() => setEditing('new')}>+ 슬라이드 추가</button>}
  </section>;
}
