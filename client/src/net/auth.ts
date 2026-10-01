export interface ClientUser {
  id: string;
  username: string;
  coins: number;
  gems: number;
  blocked: boolean;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

type AuthResponse = { ok: boolean; user?: ClientUser | null; error?: string };

async function request(path: string, options: RequestInit = {}): Promise<AuthResponse> {
  try {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) }, ...options });
    const data = await res.json().catch(() => ({}));
    return data as AuthResponse;
  } catch {
    return { ok: false, error: 'The server is unreachable. Check your connection.' };
  }
}

export const authApi = {
  me: () => request('/api/auth/me'),
  login: (username: string, password: string) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username: string, password: string) => request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST', body: '{}' }),
  changePassword: (currentPassword: string, newPassword: string) => request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
};
