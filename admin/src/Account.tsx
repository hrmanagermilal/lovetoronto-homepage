import { FormEvent, useState } from 'react';
import { api, errorText, Me } from './api';

export default function Account({ me, onChange }: { me: Me; onChange: (user: Me) => void }) {
  const [name, setName] = useState(me.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setError(''); setInfo('');
    try { onChange(await api<Me>('/me', { method: 'PATCH', json: { name } })); setInfo('이름을 저장했습니다.'); }
    catch (e) { setError(errorText(e)); }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError(''); setInfo('');
    if (next !== confirm) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return; }
    try {
      await api('/me/password', { json: { current_password: current, new_password: next } });
      setCurrent(''); setNext(''); setConfirm('');
      setInfo('비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 해제되었습니다.');
    } catch (e) { setError(errorText(e)); }
  }

  return <section>
    <h2>내 계정</h2>
    <p>{me.email} · {me.role === 'owner' ? 'Owner' : 'Editor'}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {info && <p className="info" role="status">{info}</p>}
    <form className="card" onSubmit={saveName}>
      <label>이름<input maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
      <button>이름 저장</button>
    </form>
    <form className="card" onSubmit={changePassword}>
      <h3>비밀번호 변경</h3>
      <input type="email" hidden readOnly autoComplete="username" value={me.email} />
      <label>현재 비밀번호<input type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></label>
      <label>새 비밀번호 (12자 이상)<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={next} onChange={e => setNext(e.target.value)} /></label>
      <label>새 비밀번호 확인<input type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <button>비밀번호 변경</button>
    </form>
  </section>;
}
