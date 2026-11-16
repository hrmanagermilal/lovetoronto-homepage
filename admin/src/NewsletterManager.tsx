import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText, NewsletterItem, upload } from './api';

type Draft = Omit<NewsletterItem, 'id'>;
const today = () => new Date().toLocaleDateString('en-CA');
const isLink = (url: string) => !url.startsWith('/');

function NewsletterForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: Draft; submitLabel: string; onSubmit: (draft: Draft) => Promise<void>; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));

  async function choose(kind: 'newsletter' | 'thumbnail', file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try { set(kind === 'newsletter' ? 'file_url' : 'thumbnail_url', await upload(kind, file)); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.file_url) { setError('PDF 파일을 올리거나 링크를 입력하십시오.'); return; }
    setBusy(true); setError('');
    try { await onSubmit(draft); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <form className="newsletter-form" onSubmit={submit}>
    <label>제목<input required maxLength={300} placeholder="예: 2026년 4분기 소식지 (2026 Q4 News)" value={draft.title} onChange={e => set('title', e.target.value)} /></label>
    <div className="row">
      <label>발행일 (정렬 기준)<input type="date" required value={draft.published_on} onChange={e => set('published_on', e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={draft.active} onChange={e => set('active', e.target.checked)} />홈페이지에 표시</label>
    </div>
    <div className="row">
      <label>PDF 파일 (최대 50MB)
        <input type="file" accept="application/pdf" disabled={busy} onChange={e => choose('newsletter', e.target.files?.[0])} />
        {draft.file_url && !isLink(draft.file_url) && <a href={draft.file_url} target="_blank" rel="noopener noreferrer">현재 파일 보기</a>}
      </label>
      <label>또는 외부 링크 (YouTube 영상 등, https://)
        <input type="url" maxLength={500} placeholder="https://www.youtube.com/watch?v=…" value={isLink(draft.file_url) ? draft.file_url : ''}
          onChange={e => set('file_url', e.target.value.trim())} />
      </label>
      <label>표지 이미지 (선택 · 없으면 📄 아이콘)
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => choose('thumbnail', e.target.files?.[0])} />
        {draft.thumbnail_url && <span className="thumb"><img src={draft.thumbnail_url} alt="" />
          <button type="button" className="link" onClick={() => set('thumbnail_url', '')}>표지 제거</button></span>}
      </label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      <button disabled={busy}>{busy ? '처리 중…' : submitLabel}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>취소</button>}
    </div>
  </form>;
}

export default function NewsletterManager() {
  const [items, setItems] = useState<NewsletterItem[]>([]);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<NewsletterItem[]>('/newsletters').then(setItems).catch(e => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function remove(item: NewsletterItem) {
    if (!confirm(`"${item.title}" 소식지를 삭제할까요? 업로드한 파일도 삭제됩니다.`)) return;
    try { await api(`/newsletters/${item.id}`, { method: 'DELETE' }); load(); } catch (e) { setError(errorText(e)); }
  }

  return <section>
    <h2>소식지</h2>
    <p className="muted">이 목록이 84번 홈페이지의 소식지 / News 페이지에 발행일 최신순으로, 한 페이지에 9건씩 표시됩니다. 기존 보관 소식지도 모두 여기로 옮겨져 있어 수정·숨김·삭제할 수 있습니다.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {editing === 'new' ? <div className="card">
      <h3>새 소식지 등록</h3>
      <NewsletterForm initial={{ title: '', file_url: '', thumbnail_url: '', published_on: today(), active: true }}
        submitLabel="등록" onCancel={() => setEditing(null)}
        onSubmit={async draft => { await api('/newsletters', { json: draft }); setEditing(null); load(); }} />
    </div> : <button onClick={() => setEditing('new')}>+ 소식지 등록</button>}
    {items.length === 0 ? <p className="muted">아직 등록한 소식지가 없습니다.</p> : <ul className="newsletters">
      {items.map(item => <li key={item.id} className={item.active ? '' : 'inactive'}>
        {editing === item.id ? <NewsletterForm initial={item} submitLabel="저장" onCancel={() => setEditing(null)}
          onSubmit={async draft => { await api(`/newsletters/${item.id}`, { method: 'PATCH', json: draft }); setEditing(null); load(); }} /> :
          <div className="slide-row">
            {item.thumbnail_url ? <img className="cover" src={item.thumbnail_url} alt="" /> : <span className="cover">{isLink(item.file_url) ? '🎬' : '📄'}</span>}
            <div className="slide-text">
              <strong>{item.title}</strong>
              <span className="muted">{item.published_on} · <a href={item.file_url} target="_blank" rel="noopener noreferrer">{isLink(item.file_url) ? '링크 열기' : 'PDF 보기'}</a></span>
              {!item.active && <span className="badge">숨김</span>}
            </div>
            <div className="actions">
              <button onClick={() => setEditing(item.id)}>수정</button>
              <button className="danger" onClick={() => remove(item)}>삭제</button>
            </div>
          </div>}
      </li>)}
    </ul>}
  </section>;
}
