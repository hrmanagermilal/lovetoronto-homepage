import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText, Me } from './api';

function UserRow({ user, me, onChanged }: { user: Me; me: Me; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const self = user.id === me.id;

  async function patch(values: Partial<Pick<Me, 'name' | 'role' | 'active'>>) {
    setError(''); setMessage('');
    try { await api(`/users/${user.id}`, { method: 'PATCH', json: values }); onChanged(); setMessage('저장했습니다.'); }
    catch (e) { setError(errorText(e)); }
  }
  async function sendLink() {
    setError(''); setMessage('');
    try {
      const result = await api<{ purpose: string }>(`/users/${user.id}/send-link`, { method: 'POST' });
      setMessage(result.purpose === 'invite' ? '초대 메일을 다시 보냈습니다.' : '비밀번호 재설정 메일을 보냈습니다.');
    } catch (e) { setError(errorText(e)); }
  }

  return <tr className={user.active ? '' : 'inactive'}>
    <td>{user.email}{self && <span className="badge">나</span>}</td>
    <td><input aria-label="이름" maxLength={100} value={name} onChange={e => setName(e.target.value)}
      onBlur={() => name !== user.name && patch({ name })} /></td>
    <td><select aria-label="권한" value={user.role} disabled={self} onChange={e => patch({ role: e.target.value as Me['role'] })}>
      <option value="owner">Owner</option><option value="editor">Editor</option>
    </select></td>
    <td>{!user.active ? '비활성' : user.has_password ? '사용 중' : '초대 수락 대기'}</td>
    <td>{user.last_login_at ? new Date(user.last_login_at).toLocaleString('ko-KR') : '-'}</td>
    <td className="actions">
      {!self && <button className="secondary" onClick={() => patch({ active: !user.active })}>{user.active ? '비활성화' : '활성화'}</button>}
      {user.active && !self && <button className="secondary" onClick={sendLink}>{user.has_password ? '재설정 메일' : '초대 재발송'}</button>}
      {message && <span className="info">{message}</span>}
      {error && <span className="error">{error}</span>}
    </td>
  </tr>;
}

export default function UserManager({ me }: { me: Me }) {
  const [users, setUsers] = useState<Me[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Me['role']>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const load = useCallback(() => { api<Me[]>('/users').then(setUsers).catch(e => setError(errorText(e))); }, []);
  useEffect(load, [load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setInfo('');
    try {
      await api('/users', { json: { email, name, role } });
      setInfo(`${email} 로 초대 메일을 보냈습니다. 링크는 72시간 동안 유효합니다.`);
      setEmail(''); setName(''); setRole('editor');
      load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <section>
    <h2>관리자 계정</h2>
    <p className="muted">이메일이 곧 계정입니다. 초대받은 사람이 메일 링크로 비밀번호를 정하고, 로그인할 때마다 이메일로 받은 인증 코드를 입력합니다(2단계 인증).
      <br />Owner 는 계정을 관리할 수 있고, Editor 는 Hero 이미지와 소식지만 관리합니다. 이메일 주소를 바꾸려면 새 계정을 초대하고 기존 계정을 비활성화하십시오.</p>
    <form className="card invite" onSubmit={invite}>
      <h3>새 관리자 초대</h3>
      <div className="row">
        <label>이메일<input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>이름 (선택)<input maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>권한<select value={role} onChange={e => setRole(e.target.value as Me['role'])}>
          <option value="editor">Editor (콘텐츠)</option><option value="owner">Owner (계정 관리 포함)</option>
        </select></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {info && <p className="info" role="status">{info}</p>}
      <button disabled={busy}>{busy ? '보내는 중…' : '초대 메일 보내기'}</button>
    </form>
    <div className="table-wrap"><table>
      <thead><tr><th>이메일</th><th>이름</th><th>권한</th><th>상태</th><th>최근 로그인</th><th></th></tr></thead>
      <tbody>{users.map(user => <UserRow key={`${user.id}:${user.name}`} user={user} me={me} onChanged={load} />)}</tbody>
    </table></div>
  </section>;
}
