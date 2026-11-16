import { FormEvent, useEffect, useState } from 'react';
import { api, errorText, Me } from './api';
import { go } from './useHash';

function Notice({ error, info }: { error?: string; info?: string }) {
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    {info && <p className="info" role="status">{info}</p>}
  </>;
}

export function Login({ onSignedIn }: { onSignedIn: (user: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api<{ challenge_id: string }>('/auth/login', { json: { email, password } });
      setChallenge(result.challenge_id);
      setCode('');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const user = await api<Me>('/auth/verify', { json: { challenge_id: challenge, code } });
      setPassword('');
      onSignedIn(user);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <main className="auth">
    <h1>Love Toronto 관리자</h1>
    {!challenge ? <form onSubmit={submitPassword}>
      <label>이메일<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>비밀번호<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <Notice error={error} />
      <button disabled={busy}>{busy ? '확인 중…' : '다음'}</button>
      <p className="muted"><a href="#/forgot">비밀번호를 잊으셨나요?</a></p>
    </form> : <form onSubmit={submitCode}>
      <p><strong>{email}</strong> 로 보낸 6자리 인증 코드를 입력하십시오. (10분 유효)</p>
      <label>인증 코드<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
        value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></label>
      <Notice error={error} />
      <button disabled={busy || code.length !== 6}>{busy ? '확인 중…' : '로그인'}</button>
      <button type="button" className="link" onClick={() => { setChallenge(null); setError(''); }}>코드를 다시 받기</button>
    </form>}
  </main>;
}

export function SetPassword({ token, purpose }: { token: string; purpose: 'accept' | 'reset' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ email: string }>('/auth/link-info', { json: { token } })
      .then(info => setEmail(info.email)).catch(e => setError(errorText(e)));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setError('비밀번호 확인이 일치하지 않습니다.'); return; }
    setBusy(true); setError('');
    try {
      await api('/auth/accept', { json: { token, password } });
      setDone(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <main className="auth">
    <h1>{purpose === 'accept' ? '관리자 계정 활성화' : '비밀번호 재설정'}</h1>
    {done ? <>
      <p className="info">비밀번호를 설정했습니다. 이제 로그인하십시오. 로그인할 때마다 이메일로 인증 코드가 발송됩니다.</p>
      <button onClick={() => go('/')}>로그인으로</button>
    </> : <form onSubmit={submit}>
      {email && <p>계정: <strong>{email}</strong></p>}
      <input type="email" hidden readOnly autoComplete="username" value={email} />
      <label>새 비밀번호 (12자 이상)<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label>새 비밀번호 확인<input type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <Notice error={error} />
      <button disabled={busy || !email}>비밀번호 설정</button>
    </form>}
  </main>;
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/auth/forgot', { json: { email } });
      setInfo('등록된 계정이면 비밀번호 재설정 링크를 이메일로 보냈습니다. (1시간 유효)');
    } catch (e) { setError(errorText(e)); }
  }
  return <main className="auth">
    <h1>비밀번호 재설정</h1>
    <form onSubmit={submit}>
      <label>이메일<input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <Notice error={error} info={info} />
      <button>재설정 링크 받기</button>
      <p className="muted"><a href="#/">로그인으로 돌아가기</a></p>
    </form>
  </main>;
}
