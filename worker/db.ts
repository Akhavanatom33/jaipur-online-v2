import { publicUser, type PublicUser } from './auth.ts';

export type AdminUserRow = {
  id: string;
  username: string;
  coins: number;
  gems: number;
  blocked: number;
  games_played: number;
  wins: number;
  losses: number;
  created_at: number;
  last_login_at: number | null;
};

export interface BackupPayload {
  format: 'jaipur-d1-backup';
  version: 1;
  exportedAt: string;
  users: Array<AdminUserRow & { password_hash: string }>;
  gameHistory: Array<Record<string, unknown>>;
  auditLogs: Array<Record<string, unknown>>;
}

export function now() { return Date.now(); }

export function userId(): string {
  return crypto.randomUUID();
}

export async function addAudit(db: D1Database, actorType: 'user' | 'admin' | 'system', actorId: string | null, action: string, targetUserId: string | null, details: unknown = null) {
  await db.prepare(`INSERT INTO audit_logs (actor_type, actor_id, action, target_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(actorType, actorId, action, targetUserId, JSON.stringify(details), now()).run();
}

export async function getUserById(db: D1Database, id: string) {
  return db.prepare(`SELECT id, username, coins, gems, blocked, games_played, wins, losses FROM users WHERE id = ? LIMIT 1`).bind(id).first<{
    id: string; username: string; coins: number; gems: number; blocked: number; games_played: number; wins: number; losses: number;
  }>();
}

export async function getUserByUsername(db: D1Database, usernameNorm: string): Promise<AdminUserRow | null> {
  return db.prepare(`SELECT id, username, coins, gems, blocked, games_played, wins, losses, created_at, last_login_at FROM users WHERE username_norm = ? LIMIT 1`)
    .bind(usernameNorm).first<AdminUserRow>();
}

export async function buildBackup(db: D1Database): Promise<BackupPayload> {
  const [users, gameHistory, auditLogs] = await Promise.all([
    db.prepare(`SELECT id, username, password_hash, coins, gems, blocked, games_played, wins, losses, created_at, last_login_at FROM users ORDER BY created_at`).all<AdminUserRow & { password_hash: string }>(),
    db.prepare(`SELECT * FROM game_history ORDER BY id`).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM audit_logs ORDER BY id`).all<Record<string, unknown>>(),
  ]);
  return {
    format: 'jaipur-d1-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    users: users.results ?? [],
    gameHistory: gameHistory.results ?? [],
    auditLogs: auditLogs.results ?? [],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function restoreBackup(db: D1Database, backup: BackupPayload): Promise<{ users: number; games: number; logs: number }> {
  if (backup.format !== 'jaipur-d1-backup' || backup.version !== 1) throw new Error('Unsupported backup format.');
  if (!Array.isArray(backup.users) || !Array.isArray(backup.gameHistory) || !Array.isArray(backup.auditLogs)) throw new Error('Backup is incomplete.');

  await db.batch([
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM game_history'),
    db.prepare('DELETE FROM audit_logs'),
    db.prepare('DELETE FROM users'),
  ]);

  for (const group of chunk(backup.users, 25)) {
    await db.batch(group.map((u) => db.prepare(`INSERT INTO users (id, username, username_norm, password_hash, coins, gems, blocked, games_played, wins, losses, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.id, u.username, String(u.username).normalize('NFKC').trim().toLocaleLowerCase(), u.password_hash, Number(u.coins ?? 0), Number(u.gems ?? 0), Number(u.blocked ?? 0), Number(u.games_played ?? 0), Number(u.wins ?? 0), Number(u.losses ?? 0), Number(u.created_at ?? now()), u.last_login_at == null ? null : Number(u.last_login_at))));
  }

  for (const group of chunk(backup.gameHistory, 25)) {
    await db.batch(group.map((g) => db.prepare(`INSERT INTO game_history (id, room_id, player1_user_id, player2_user_id, winner_user_id, round_count, result_json, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(Number(g.id), String(g.room_id), String(g.player1_user_id), String(g.player2_user_id), g.winner_user_id == null ? null : String(g.winner_user_id), Number(g.round_count ?? 0), String(g.result_json ?? '{}'), Number(g.ended_at ?? now()))));
  }

  for (const group of chunk(backup.auditLogs, 25)) {
    await db.batch(group.map((a) => db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(Number(a.id), String(a.actor_type), a.actor_id == null ? null : String(a.actor_id), String(a.action), a.target_user_id == null ? null : String(a.target_user_id), String(a.details_json ?? 'null'), Number(a.created_at ?? now()))));
  }

  return { users: backup.users.length, games: backup.gameHistory.length, logs: backup.auditLogs.length };
}

export function toPublicUser(row: { id: string; username: string; coins: number; gems: number; blocked: number; games_played: number; wins: number; losses: number }): PublicUser {
  return publicUser(row);
}
