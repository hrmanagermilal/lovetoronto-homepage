import { useEffect, useState } from 'react';
import { api, Me } from './api';
import { Forgot, Login, SetPassword } from './Auth';
import Account from './Account';
import HeroManager from './HeroManager';
import NewsletterManager from './NewsletterManager';
import UserManager from './UserManager';
import { go, useHash } from './useHash';

const TABS = [
  { path: '/hero', label: 'Hero 이미지' },
  { path: '/newsletters', label: '소식지' },
  { path: '/users', label: '관리자 계정', owner: true },
  { path: '/account', label: '내 계정' },
];

export default function App() {
  const { path, params } = useHash();
  const [user, setUser] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api<Me>('/me').then(setUser).catch(() => setUser(null));
    const signedOut = () => setUser(null);
    addEventListener('admin-signed-out', signedOut);
    return () => removeEventListener('admin-signed-out', signedOut);
  }, []);

  if (path === '/accept' || path === '/reset') {
    const token = params.get('token') || '';
    return <SetPassword key={token} token={token} purpose={path === '/accept' ? 'accept' : 'reset'} />;
  }
  if (path === '/forgot') return <Forgot />;
  if (user === undefined) return <main className="auth"><p>불러오는 중…</p></main>;
  if (!user) return <Login onSignedIn={signedIn => { setUser(signedIn); go('/hero'); }} />;

  const tabs = TABS.filter(tab => !tab.owner || user.role === 'owner');
  const current = tabs.find(tab => tab.path === path)?.path || '/hero';
  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }
  const front = `https://${location.hostname}:84/`;
  return <>
    <header className="top">
      <strong>Love Toronto 관리자</strong>
      <nav>{tabs.map(tab => <a key={tab.path} href={`#${tab.path}`} aria-current={tab.path === current ? 'page' : undefined}>{tab.label}</a>)}</nav>
      <span className="who">
        <a href={front} target="_blank" rel="noopener noreferrer">새 홈페이지(84) 보기 ↗</a>
        {user.name || user.email} · {user.role === 'owner' ? 'Owner' : 'Editor'}
        <button className="link" onClick={logout}>로그아웃</button>
      </span>
    </header>
    <main className="page">
      {current === '/hero' && <HeroManager />}
      {current === '/newsletters' && <NewsletterManager />}
      {current === '/users' && <UserManager me={user} />}
      {current === '/account' && <Account me={user} onChange={setUser} />}
    </main>
  </>;
}
