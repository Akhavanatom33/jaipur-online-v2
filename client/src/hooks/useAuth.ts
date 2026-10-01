import { useCallback, useEffect, useState } from 'react';
import type { ClientUser } from '../net/auth.ts';
import { authApi } from '../net/auth.ts';

export interface AuthApi {
  user: ClientUser | null;
  loading: boolean;
  message: string | null;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  register: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearMessage: () => void;
}

export function useAuth(): AuthApi {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    authApi.me().then((res) => {
      if (!alive) return;
      setUser(res.ok ? res.user ?? null : null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    if (res.ok && res.user) { setUser(res.user); setMessage(null); return { ok: true }; }
    return { ok: false, error: res.error ?? 'Login failed.' };
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await authApi.register(username, password);
    if (res.ok && res.user) { setUser(res.user); setMessage(null); return { ok: true }; }
    return { ok: false, error: res.error ?? 'Registration failed.' };
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  /** Re-read coins / stats (for example after a finished game). */
  const refresh = useCallback(async () => {
    const res = await authApi.me();
    if (res.ok && res.user) setUser(res.user);
  }, []);

  return { user, loading, message, login, register, logout, refresh, clearMessage: () => setMessage(null) };
}
