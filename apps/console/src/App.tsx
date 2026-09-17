import { useCallback, useEffect, useState } from 'react';

import { api, whenSignedOut, type Operator } from './api.ts';
import { Login } from './Login.tsx';
import { Shell } from './Shell.tsx';

type Session = { state: 'checking' } | { state: 'signed-out' } | { state: 'signed-in'; operator: Operator; network: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' });

  const refresh = useCallback(async () => {
    try {
      const { operator, network } = await api.me();
      setSession({ state: 'signed-in', operator, network });
    } catch {
      setSession({ state: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    // Any request that comes back 401 — an expired or idle session, or an
    // operator disabled mid-shift — drops straight back to sign-in.
    whenSignedOut(() => setSession({ state: 'signed-out' }));
    void refresh();
  }, [refresh]);

  if (session.state === 'checking') return null;
  if (session.state === 'signed-out') return <Login onSignedIn={refresh} />;

  return (
    <Shell
      operator={session.operator}
      network={session.network}
      onSignOut={async () => {
        try {
          await api.logout();
        } finally {
          setSession({ state: 'signed-out' });
        }
      }}
    />
  );
}
