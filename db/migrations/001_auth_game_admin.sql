PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0,
  gems INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_login_at ON users(last_login_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS game_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  player1_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player2_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  winner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  round_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL,
  ended_at INTEGER NOT NULL,
  game_record_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_game_history_ended_at ON game_history(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_history_player1 ON game_history(player1_user_id);
CREATE INDEX IF NOT EXISTS idx_game_history_player2 ON game_history(player2_user_id);
CREATE INDEX IF NOT EXISTS idx_game_history_winner ON game_history(winner_user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_user_id TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user ON audit_logs(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_states (
  admin_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  payload_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
