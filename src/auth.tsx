import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken } from './api';

export type UserRole = 'admin' | 'operator' | 'viewer';
export interface CurrentUser { id: number; username: string; role: UserRole }
type AuthState = 'loading' | 'setup' | 'anonymous' | 'authenticated';
interface SessionResponse { user: CurrentUser; csrfToken: string }
interface AuthContextValue {
  state: AuthState;
  user?: CurrentUser;
  setup: (token: string, username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading');
  const [user, setUser] = useState<CurrentUser>();
  const accept = useCallback((session: SessionResponse) => {
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setState('authenticated');
  }, []);
  const load = useCallback(async () => {
    setState('loading');
    try {
      const setupStatus = await api<{ required: boolean }>('/auth/setup-status');
      if (setupStatus.required) {
        setCsrfToken(undefined); setUser(undefined); setState('setup'); return;
      }
      accept(await api<SessionResponse>('/auth/session'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken(undefined); setUser(undefined); setState('anonymous'); return;
      }
      setState('anonymous');
    }
  }, [accept]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const unauthorized = () => { setCsrfToken(undefined); setUser(undefined); setState('anonymous'); };
    window.addEventListener('backmygit:unauthorized', unauthorized);
    return () => window.removeEventListener('backmygit:unauthorized', unauthorized);
  }, []);
  const value = useMemo<AuthContextValue>(() => ({
    state,
    user,
    setup: async (token, username, password) => accept(await api<SessionResponse>('/auth/setup', {
      method: 'POST', body: JSON.stringify({ token, username, password }),
    })),
    login: async (username, password) => accept(await api<SessionResponse>('/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    })),
    logout: async () => {
      try { await api('/auth/logout', { method: 'POST', body: '{}' }); } finally {
        setCsrfToken(undefined); setUser(undefined); setState('anonymous');
      }
    },
  }), [accept, state, user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
