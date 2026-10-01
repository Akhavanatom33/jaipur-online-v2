import { DurableObject } from 'cloudflare:workers';
import type { Ack, ClientToServerEvents } from '../shared/protocol.ts';
import type { GameMode, PlayerIndex } from '../shared/types.ts';
import { RoomManager } from '../server/rooms/RoomManager.ts';
import { MemoryRoomStore } from '../server/rooms/store.ts';
import type { Room } from '../server/rooms/types.ts';
import { addAudit, getUserById } from './db.ts';
import { LOSS_COINS, TURN_SECONDS, modeConfig } from '../shared/constants.ts';
import { ensureSchema } from './schema.ts';
import { getCurrentUser, hashPassword, issueSession, normalizeUsername, publicUser, revokeSession, validatePassword, validateUsername, verifyPassword } from './auth.ts';

export interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  /** Optional variable: seconds per turn (10-300). Defaults to 20. */
  TURN_SECONDS?: string;
  /** Optional (voice chat behind strict NATs): Cloudflare Realtime TURN key id + API token (secret). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/** Voice chat ICE servers. STUN is enough for most networks; TURN (optional) relays the rest. */
const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

async function loadIceServers(env: Env): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    if (!res.ok) return STUN_ONLY;
    const data = await res.json() as { iceServers?: unknown };
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    return list.length ? list : STUN_ONLY;
  } catch {
    return STUN_ONLY;
  }
}

function turnMsFrom(raw: string | undefined): number {
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 10 && n <= 300 ? n : TURN_SECONDS) * 1000;
}

type SeatGrantRes = { roomId: string; token: string; you: PlayerIndex };

type JsonRecord = Record<string, unknown>;

function json(data: unknown, status = 200, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers: h });
}

function error(message: string, status = 400, extra: JsonRecord = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function readJson(request: Request): Promise<JsonRecord> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value as JsonRecord : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      const stub = env.HUB.get(env.HUB.idFromName('main'));
      const res = await stub.fetch(new Request(new URL('/api/health', request.url), request));
      if (url.searchParams.get('deep') !== '1') return res;
      // Deep check: also proves the D1 binding works and the tables exist.
      const hub = await res.json() as JsonRecord;
      try {
        await ensureSchema(env.DB);
        const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
        return json({ ...hub, db: true, users: Number(row?.c ?? 0), adminTokenSet: Boolean(env.ADMIN_API_TOKEN) });
      } catch (e) {
        return json({ ...hub, db: false, error: String(e) }, 503);
      }
    }

    const needsDb = url.pathname.startsWith('/api/auth/') || url.pathname === '/ws' || url.pathname === '/api/admin/presence' || url.pathname === '/api/voice/ice';
    if (needsDb) {
      try { await ensureSchema(env.DB); } catch (e) {
        console.error('D1 schema bootstrap failed', e);
        return error('Database is not available. Check the D1 binding (database_id) of this Worker.', 503);
      }
    }

    if (url.pathname.startsWith('/api/auth/')) {
      if (!sameOrigin(request)) return error('Cross-origin request blocked.', 403);

      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await getCurrentUser(env.DB, request);
        return json({ ok: true, user });
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        const body = await readJson(request);
        const usernameError = validateUsername(body.username);
        const passwordError = validatePassword(body.password);
        if (usernameError) return error(usernameError);
        if (passwordError) return error(passwordError);
        const username = normalizeUsername(body.username);
        const password = String(body.password);
        const exists = await env.DB.prepare('SELECT id FROM users WHERE username_norm = ? LIMIT 1').bind(username).first<{ id: string }>();
        if (exists) return error('This username is already registered.', 409);
        const id = crypto.randomUUID();
        const passwordHash = await hashPassword(password);
        const now = Date.now();
        try {
          await env.DB.prepare(`INSERT INTO users (id, username, username_norm, password_hash, coins, gems, blocked, games_played, wins, losses, created_at, last_login_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)`)
            .bind(id, String(body.username).normalize('NFKC').trim(), username, passwordHash, now, now).run();
        } catch (e) {
          if (String(e).includes('UNIQUE')) return error('This username is already registered.', 409);
          throw e;
        }
        await addAudit(env.DB, 'user', id, 'register', id, { username });
        const headers = await issueSession(env.DB, id, request);
        return json({ ok: true, user: { id, username: String(body.username).normalize('NFKC').trim(), coins: 0, gems: 0, blocked: false, gamesPlayed: 0, wins: 0, losses: 0 } }, 201, headers);
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const body = await readJson(request);
        const usernameError = validateUsername(body.username);
        const passwordError = validatePassword(body.password);
        if (usernameError || passwordError) return error('Username or password is invalid.');
        const username = normalizeUsername(body.username);
        const row = await env.DB.prepare(`SELECT id, username, password_hash, coins, gems, blocked, games_played, wins, losses FROM users WHERE username_norm = ? LIMIT 1`)
          .bind(username).first<{ id: string; username: string; password_hash: string; coins: number; gems: number; blocked: number; games_played: number; wins: number; losses: number }>();
        if (!row || !(await verifyPassword(String(body.password), row.password_hash))) return error('Username or password is incorrect.', 401);
        if (Number(row.blocked) === 1) return error('This account is blocked. Contact the administrator.', 403);
        await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
        await addAudit(env.DB, 'user', row.id, 'login', row.id);
        const headers = await issueSession(env.DB, row.id, request);
        return json({ ok: true, user: publicUser(row) }, 200, headers);
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const user = await getCurrentUser(env.DB, request);
        const headers = await revokeSession(env.DB, request);
        if (user) await addAudit(env.DB, 'user', user.id, 'logout', user.id);
        return json({ ok: true }, 200, headers);
      }

      if (url.pathname === '/api/auth/change-password' && request.method === 'POST') {
        const user = await getCurrentUser(env.DB, request);
        if (!user) return error('You must be logged in.', 401);
        const body = await readJson(request);
        const passwordError = validatePassword(body.newPassword);
        if (passwordError) return error(passwordError);
        const current = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ? LIMIT 1').bind(user.id).first<{ password_hash: string }>();
        if (!current || !(await verifyPassword(String(body.currentPassword ?? ''), current.password_hash))) return error('Current password is incorrect.', 401);
        const passwordHash = await hashPassword(String(body.newPassword));
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, user.id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
        ]);
        const headers = await issueSession(env.DB, user.id, request);
        await addAudit(env.DB, 'user', user.id, 'change_password', user.id);
        return json({ ok: true }, 200, headers);
      }
    }

    if (url.pathname === '/api/admin/presence' && request.method === 'GET') {
      if (!env.ADMIN_API_TOKEN || request.headers.get('X-Admin-API-Token') !== env.ADMIN_API_TOKEN) return error('Unauthorized.', 401);
      const stub = env.HUB.get(env.HUB.idFromName('main'));
      return stub.fetch(new Request(new URL('/internal/admin/presence', request.url), { headers: { 'X-Admin-API-Token': env.ADMIN_API_TOKEN } }));
    }

    if (url.pathname === '/api/voice/ice' && request.method === 'GET') {
      const user = await getCurrentUser(env.DB, request);
      if (!user) return error('Authentication required.', 401);
      return json({ ok: true, iceServers: await loadIceServers(env) });
    }

    if (url.pathname === '/ws') {
      const user = await getCurrentUser(env.DB, request);
      if (!user) return error('Authentication required.', 401);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket upgrade required.', 426);
      const headers = new Headers(request.headers);
      headers.set('X-User-ID', user.id);
      headers.set('X-User-Name', user.username);
      const forwarded = new Request(request, { headers });
      const stub = env.HUB.get(env.HUB.idFromName('main'));
      return stub.fetch(forwarded);
    }

    return env.ASSETS.fetch(request);
  },
};

export class JaipurHub extends DurableObject<Env> {
  private store = new MemoryRoomStore();
  private manager = new RoomManager(this.store, { turnMs: turnMsFrom(this.env.TURN_SECONDS) });
  private sockets = new Map<string, WebSocket>();
  private socketUsers = new Map<string, { id: string; username: string }>();
  private lastPersist = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Room[]>('rooms');
      for (const room of saved ?? []) {
        for (const p of room.players) if (p) { p.socketId = null; p.connected = false; }
        this.store.set(room);
      }
      this.manager.restoreIndex();
      await this.scheduleAlarm();
    });
  }

  /** Durable Object alarm: enforce turn timers even when no client sends anything. */
  async alarm(): Promise<void> {
    this.alarmAt = null;
    const changed = this.manager.expireTurns();
    for (const room of changed) {
      await this.recordGameIfFinished(room);
      this.broadcast(room);
    }
    this.manager.sweep();
    this.persist();
    await this.scheduleAlarm();
  }

  private alarmAt: number | null = null;

  private async scheduleAlarm() {
    const next = this.manager.nextDeadline();
    if (next === null) {
      if (this.alarmAt !== null) { this.alarmAt = null; await this.ctx.storage.deleteAlarm(); }
      return;
    }
    const at = Math.max(next, Date.now() + 250);
    if (this.alarmAt !== null && Math.abs(this.alarmAt - at) < 400) return;
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, rooms: this.manager.activeRoomCount(), online: this.uniqueOnlineUsers(), playing: this.uniquePlayingUsers() });
    }
    if (url.pathname === '/internal/admin/presence') {
      if (request.headers.get('X-Admin-API-Token') !== this.env.ADMIN_API_TOKEN) return new Response('Unauthorized', { status: 401 });
      return Response.json({ ok: true, onlinePlayers: this.uniqueOnlineUsers(), playingPlayers: this.uniquePlayingUsers(), activeRooms: this.manager.activeRoomCount(), sockets: this.sockets.size });
    }
    const userId = request.headers.get('X-User-ID');
    const username = request.headers.get('X-User-Name');
    if (!userId || !username) return new Response('Unauthorized', { status: 401 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const sid = crypto.randomUUID();
    this.sockets.set(sid, server);
    this.socketUsers.set(sid, { id: userId, username });

    server.addEventListener('message', (ev) => this.onMessage(sid, ev.data));
    const close = () => {
      if (this.sockets.get(sid) !== server) return;
      this.sockets.delete(sid);
      this.socketUsers.delete(sid);
      this.broadcast(this.manager.handleDisconnect(sid));
      this.persist();
    };
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    server.send(JSON.stringify({ t: 'hello', user: { id: userId, username } }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(sid: string, msg: unknown) {
    try { this.sockets.get(sid)?.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  private broadcast(room: Room | null | undefined) {
    if (!room || !this.manager.getRoom(room.id)) return;
    const seats = this.manager.voiceSeats(room);
    room.players.forEach((p, seat) => {
      if (!p?.socketId) return;
      this.send(p.socketId, { t: 'event', event: 'room:state', payload: this.manager.viewFor(room, seat as PlayerIndex) });
      this.send(p.socketId, { t: 'event', event: 'voice:peers', payload: { seats } });
    });
  }

  /** Send one event to every connected player of a room. */
  private broadcastEvent(room: Room, event: string, payload: unknown) {
    for (const p of room.players) if (p?.socketId) this.send(p.socketId, { t: 'event', event, payload });
  }

  private persist() {
    const rooms = [...this.store.values()];
    const json = JSON.stringify(rooms);
    if (json === this.lastPersist) return;
    this.lastPersist = json;
    void this.ctx.storage.put('rooms', rooms);
  }

  private uniqueOnlineUsers(): number {
    return new Set(this.socketUsers.values()).size;
  }

  private uniquePlayingUsers(): number {
    const ids = new Set<string>();
    for (const room of this.store.values()) {
      if (room.game?.phase !== 'playing') continue;
      for (const p of room.players) if (p?.connected) ids.add(p.userId);
    }
    return ids.size;
  }

  private async recordGameIfFinished(room: Room) {
    const game = room.game;
    if (!game || game.phase !== 'gameOver' || room.gameRecordId) return;
    const seated = room.players.filter((p): p is NonNullable<typeof p> => p !== null);
    if (seated.length < 2 || game.winner === null || seated.length !== room.players.length) return;
    const recordId = crypto.randomUUID();
    room.gameRecordId = recordId;
    try {
      await this.writeGameRecord(room, recordId);
    } catch (e) {
      // Never break a live game because the history write failed; allow a retry later.
      room.gameRecordId = null;
      console.error('could not record finished game', e);
    }
  }

  private async writeGameRecord(room: Room, recordId: string) {
    const game = room.game!;
    const ids = room.players.map((p) => p!.userId);
    const mode = (room.mode ?? ids.length) as GameMode;
    const winnerId = ids[game.winner as number];
    const winCoins = modeConfig(mode).winCoins;
    // game_history keeps two player columns (schema unchanged); every participant is listed in result_json.
    const resultJson = JSON.stringify({ mode, players: ids, results: game.results, winner: game.winner, seals: game.seals, forfeit: game.forfeit ?? null });
    const losers = [...new Set(ids.filter((id) => id !== winnerId))];
    // One atomic batch: history row, win/loss counters, small coin rewards and the audit entry.
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT OR IGNORE INTO game_history (room_id, player1_user_id, player2_user_id, winner_user_id, round_count, result_json, ended_at, game_record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(room.id, ids[0], ids[1], winnerId, game.results.length, resultJson, Date.now(), recordId),
      this.env.DB.prepare(`UPDATE users SET games_played = games_played + 1, wins = wins + 1, coins = coins + ? WHERE id = ?`).bind(winCoins, winnerId),
      ...losers.map((id) => this.env.DB.prepare(`UPDATE users SET games_played = games_played + 1, losses = losses + 1, coins = coins + ? WHERE id = ?`).bind(LOSS_COINS, id)),
      this.env.DB.prepare(`INSERT INTO audit_logs (actor_type, actor_id, action, target_user_id, details_json, created_at) VALUES ('system', NULL, 'game_finished', ?, ?, ?)`)
        .bind(winnerId, JSON.stringify({ roomId: room.id, recordId, mode, players: ids, forfeit: game.forfeit ?? null }), Date.now()),
    ]);
  }

  private async onMessage(sid: string, raw: unknown) {
    let msg: { t?: string; id?: number; event?: keyof ClientToServerEvents; payload?: any };
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'ping') return this.send(sid, { t: 'pong' });
    if (msg.t !== 'emit' || typeof msg.id !== 'number') return;

    const auth = this.socketUsers.get(sid);
    if (!auth) return this.send(sid, { t: 'ack', id: msg.id, res: { ok: false, code: 'SESSION_EXPIRED', error: 'Session expired. Log in again.' } });
    if (msg.event !== undefined && msg.event !== 'voice:signal') {
      const liveUser = await getUserById(this.env.DB, auth.id);
      if (!liveUser || Number(liveUser.blocked) === 1) {
        this.send(sid, { t: 'ack', id: msg.id, res: { ok: false, code: 'SESSION_EXPIRED', error: 'This account is no longer active.' } });
        try { this.sockets.get(sid)?.close(4003, 'account blocked'); } catch { /* ignore */ }
        return;
      }
    }
    const id = msg.id;
    const payload = msg.payload ?? {};
    const reply: Ack<any> = (res) => this.send(sid, { t: 'ack', id, res });
    const m = this.manager;
    const grant = async (res: ReturnType<RoomManager['createRoom']>) => {
      if (!res.ok) return reply(res);
      for (const r of res.affected) { await this.recordGameIfFinished(r); this.broadcast(r); }
      reply({ ok: true, roomId: res.room.id, token: res.token, you: res.seat } satisfies { ok: true } & SeatGrantRes);
      this.broadcast(res.room);
      this.send(sid, { t: 'event', event: 'chat:history', payload: m.chatHistory(res.room) });
      this.persist();
    };

    switch (msg.event) {
      case 'room:create': await grant(m.createRoom(auth.id, auth.username, sid, payload.mode)); break;
      case 'room:join': await grant(m.joinRoom(auth.id, auth.username, payload.roomId, sid)); break;
      case 'room:rejoin': await grant(m.rejoinRoom(auth.id, payload.roomId, payload.token, sid)); break;
      case 'room:leave': {
        const room = m.leaveRoom(sid);
        if (room) await this.recordGameIfFinished(room);
        reply({ ok: true });
        this.broadcast(room);
        break;
      }
      case 'game:action': {
        const res = m.act(sid, payload.action);
        if (!res.ok) return reply(res);
        await this.recordGameIfFinished(res.room);
        reply({ ok: true });
        this.broadcast(res.room);
        break;
      }
      case 'game:continue': {
        const res = m.continueGame(sid);
        if (!res.ok) return reply(res);
        if (res.advanced && res.room.game?.phase !== 'gameOver') res.room.gameRecordId = null;
        await this.recordGameIfFinished(res.room);
        reply({ ok: true });
        this.broadcast(res.room);
        break;
      }
      case 'chat:send': {
        const res = m.chat(sid, payload.text);
        if (!res.ok) return reply(res);
        reply({ ok: true });
        this.broadcastEvent(res.room, 'chat:message', res.message);
        break;
      }
      case 'voice:join': {
        const res = m.voiceJoin(sid);
        if (!res.ok) return reply(res);
        reply({ ok: true });
        this.broadcast(res.room);
        break;
      }
      case 'voice:leave': {
        const res = m.voiceLeave(sid);
        if (!res.ok) return reply(res);
        reply({ ok: true });
        this.broadcast(res.room);
        break;
      }
      case 'voice:signal': {
        // Relay WebRTC offers/answers/candidates between two members of the same voice channel.
        if (JSON.stringify(payload.data ?? null).length > 24_000) return reply({ ok: false, code: 'BAD_REQUEST', error: 'Signal too large.' });
        const route = m.voiceRoute(sid, payload.to);
        if (!route.ok) return reply(route);
        this.send(route.toSocketId, { t: 'event', event: 'voice:signal', payload: { from: route.from, data: payload.data } });
        reply({ ok: true });
        return; // nothing in the game changed: skip persist/alarm work
      }
      default: reply({ ok: false, code: 'BAD_REQUEST', error: 'Unknown request.' });
    }
    m.sweep();
    this.persist();
    await this.scheduleAlarm();
  }
}
