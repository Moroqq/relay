import { useCallback, useEffect, useState } from 'react';

import { api, whenSignedOut, type Me } from './api.ts';
import { Invite } from './Invite.tsx';
import { Shell } from './Shell.tsx';
import { SignIn } from './SignIn.tsx';

type Session = { state: 'checking' } | { state: 'signed-out' } | { state: 'signed-in'; me: Me };

/** An invitation link is /app/#/invite/<token>: the token never reaches a server log. */
const inviteToken = (): string | null => /^#\/invite\/([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? null;

export function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' });
  const [token, setToken] = useState<string | null>(inviteToken);

  const refresh = useCallback(async () => {
    try {
      setSession({ state: 'signed-in', me: await api.me() });
    } catch {
      setSession({ state: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    whenSignedOut(() => setSession({ state: 'signed-out' }));
    const onHash = () => setToken(inviteToken());
    window.addEventListener('hashchange', onHash);
    void refresh();
    return () => window.removeEventListener('hashchange', onHash);
  }, [refresh]);

  if (token !== null) return <Invite token={token} onDone={() => { setToken(null); void refresh(); }} />;
  if (session.state === 'checking') return null;
  if (session.state === 'signed-out') return <SignIn onSignedIn={refresh} />;
  return (
    <Shell
      me={session.me}
      onSignOut={async () => {
        try { await api.logout(); } catch { /* signed out either way */ }
        setSession({ state: 'signed-out' });
      }}
    />
  );
}
