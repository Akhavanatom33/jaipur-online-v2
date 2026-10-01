export const SESSION_COOKIE = 'jaipur_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 100_000;
const textEncoder = new TextEncoder();

type UserRow = {
  id: string;
  username: string;
  coins: number;
  gems: number;
  blocked: number;
  games_played: number;
  wins: number;
  losses: number;
};

export interface PublicUser {
  id: string;
  username: string;
  coins: number;
  gems: number;
  blocked: boolean;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

export function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    coins: Number(row.coins ?? 0),
    gems: Number(row.gems ?? 0),
    blocked: Number(row.blocked ?? 0) === 1,
    gamesPlayed: Number(row.games_played ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
  };
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(input: Uint8Array | string): Promise<Uint8Array> {
  const data = (typeof input === 'string' ? textEncoder.encode(input) : input) as BufferSource;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToB64Url(salt)}$${bytesToB64Url(derived)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 500_000) return false;
  try {
    const salt = b64UrlToBytes(parts[2]);
    const expected = b64UrlToBytes(parts[3]);
    const actual = await derivePassword(password, salt, iterations);
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function normalizeUsername(input: unknown): string {
  return typeof input === 'string' ? input.normalize('NFKC').trim().toLocaleLowerCase() : '';
}

export function validateUsername(input: unknown): string | null {
  const value = normalizeUsername(input);
  if (value.length < 3 || value.length > 24) return 'Username must be 3 to 24 characters.';
  if (!/^[\p{L}\p{N}_]+$/u.test(value)) return 'Username can contain letters, numbers and underscore only.';
  return null;
}

export function validatePassword(input: unknown): string | null {
  if (typeof input !== 'string') return 'Password is required.';
  if (input.length < 8) return 'Password must be at least 8 characters.';
  if (input.length > 128) return 'Password must be at most 128 characters.';
  return null;
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function sessionCookie(token: string, request: Request, maxAge = SESSION_TTL_MS / 1000): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(maxAge)}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie('', request, 0);
}

export async function issueSession(db: D1Database, userId: string, request: Request): Promise<Headers> {
  const raw = bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = bytesToB64Url(await sha256(raw));
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, userId, now, expires, now).run();
  const headers = new Headers();
  headers.set('Set-Cookie', sessionCookie(raw, request));
  return headers;
}

export async function revokeSession(db: D1Database, request: Request): Promise<Headers> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) {
    const hash = bytesToB64Url(await sha256(token));
    await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(hash).run();
  }
  const headers = new Headers();
  headers.set('Set-Cookie', clearSessionCookie(request));
  return headers;
}

export async function getCurrentUser(db: D1Database, request: Request): Promise<PublicUser | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  let hash: string;
  try { hash = bytesToB64Url(await sha256(token)); } catch { return null; }
  const now = Date.now();
  const row = await db.prepare(`
    SELECT u.id, u.username, u.coins, u.gems, u.blocked, u.games_played, u.wins, u.losses
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(hash, now).first<UserRow>();
  if (!row || Number(row.blocked) === 1) return null;
  return publicUser(row);
}
