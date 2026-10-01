import { useEffect, useState, type FormEvent } from 'react';
import { ROOM_CODE_LENGTH, isRoomCodeFormat, normalizeRoomCode } from '../../../shared/protocol.ts';
import type { RoomApi } from '../hooks/useRoom.ts';
import type { ClientUser } from '../net/auth.ts';
import { CardView } from '../components/CardView.tsx';
import { local } from '../net/storage.ts';

const CODE_KEY = 'jaipur.room_code';

export function Home({ room, user, onLogout }: { room: RoomApi; user: ClientUser; onLogout: () => Promise<void> }) {
  const [code, setCode] = useState(() => normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? local.get(CODE_KEY) ?? '').slice(0, ROOM_CODE_LENGTH));
  const [mode, setMode] = useState<'choose' | 'join'>(() => (code ? 'join' : 'choose'));
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(room.notice);
  const [logoutBusy, setLogoutBusy] = useState(false);

  useEffect(() => { local.set(CODE_KEY, code); }, [code]);
  useEffect(() => { if (room.notice) { setError(room.notice); room.dismissNotice(); } }, [room.notice, room.dismissNotice]);

  const create = async () => {
    setBusy('create'); setError(null);
    const res = await room.create();
    setBusy(null);
    if (!res.ok) setError(res.error);
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeRoomCode(code);
    if (!isRoomCodeFormat(c)) { setError(`کد اتاق باید ${ROOM_CODE_LENGTH} کاراکتر باشد.`); return; }
    setBusy('join'); setError(null);
    const res = await room.join(c);
    setBusy(null);
    if (!res.ok) setError(res.error);
    else history.replaceState(null, '', location.pathname);
  };

  const logout = async () => {
    setLogoutBusy(true);
    await onLogout();
    setLogoutBusy(false);
  };

  return (
    <main className="home">
      <div className="home__hero">
        <div className="home__cards" aria-hidden>
          {(['diamond', 'gold', 'camel', 'spice', 'cloth'] as const).map((t, i) => (
            <CardView key={t} card={{ id: `hero-${t}`, type: t }} flip={false} style={{ ['--i' as string]: i - 2 }} className="home__card" />
          ))}
        </div>
        <div className="account-pill">
          <span className="account-pill__dot" />
          <span>{user.username}</span>
          <span className="account-pill__balance">🪙 {user.coins} · 💎 {user.gems}</span>
          <button type="button" className="btn btn--link" onClick={logout} disabled={logoutBusy}>{logoutBusy ? '…' : 'خروج'}</button>
        </div>
        <p className="eyebrow">A two-player trading game</p>
        <h1 className="home__title">Jaipur</h1>
        <p className="home__tag">Trade goods in the Pink City's bazaar. Outsell your rival for two Seals of Excellence.</p>
      </div>

      <div className="home__panel">
        {mode === 'choose' ? (
          <div className="home__choices">
            <button type="button" className="btn btn--primary btn--xl" onClick={create} disabled={!!busy || !room.connected}>
              {busy === 'create' ? 'Opening your stall…' : 'Create room'}
            </button>
            <button type="button" className="btn btn--ghost btn--xl" onClick={() => { setMode('join'); setError(null); }} disabled={!!busy}>
              Join room
            </button>
          </div>
        ) : (
          <form className="join" onSubmit={join} noValidate>
            <label className="field">
              <span className="field__label">Room code</span>
              <input
                className={`input input--code ${error ? 'is-invalid' : ''}`}
                value={code}
                autoFocus
                inputMode="text"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="K7P4X"
                maxLength={ROOM_CODE_LENGTH}
                aria-invalid={!!error}
                onChange={(e) => { setCode(normalizeRoomCode(e.target.value).slice(0, ROOM_CODE_LENGTH)); setError(null); }}
              />
            </label>
            <div className="home__choices">
              <button type="submit" className="btn btn--primary btn--xl" disabled={!!busy || !room.connected || code.length !== ROOM_CODE_LENGTH}>
                {busy === 'join' ? 'Joining…' : 'Join'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => { setMode('choose'); setError(null); }}>Back</button>
            </div>
          </form>
        )}

        <p className={`form-error ${error ? 'is-shown' : ''}`} role="alert">{error ?? ' '}</p>
        {!room.connected && <p className="muted small">Connecting to the bazaar…</p>}
        <div className="player-stats">
          <span>بازی‌ها: {user.gamesPlayed}</span><span>بردها: {user.wins}</span><span>باخت‌ها: {user.losses}</span>
        </div>
      </div>
    </main>
  );
}
