import { useEffect } from 'react';
import { Social } from './components/Social.tsx';
import { Ambience } from './components/Ambience.tsx';
import { GamePage } from './pages/GamePage.tsx';
import { Home } from './pages/Home.tsx';
import { Lobby } from './pages/Lobby.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { useAuth } from './hooks/useAuth.ts';
import { useRoom } from './hooks/useRoom.ts';

export function App() {
  const auth = useAuth();
  const room = useRoom(Boolean(auth.user));
  const { refresh } = auth;
  const inLobbyOrHome = !room.view;

  // Coins and win/loss counters change when a game ends: re-read them back on the home screen.
  useEffect(() => { if (auth.user && inLobbyOrHome && !room.restoring) void refresh(); }, [inLobbyOrHome, room.restoring]); // eslint-disable-line react-hooks/exhaustive-deps

  const myTurn = Boolean(room.view?.game && room.view.game.phase === 'playing' && room.view.game.round.currentPlayer === room.view.you);

  let page;
  if (auth.loading) {
    page = (
      <main className="splash">
        <span className="brand brand--big brand--shine">Jaipur</span>
        <p className="muted">در حال آماده‌سازی حساب…</p>
        <span className="loader" aria-hidden><i /><i /><i /></span>
      </main>
    );
  } else if (!auth.user) {
    page = <AuthPage auth={auth} />;
  } else if (room.restoring) {
    page = (
      <main className="splash">
        <span className="brand brand--big brand--shine">Jaipur</span>
        <p className="muted">Finding your seat…</p>
        <span className="loader" aria-hidden><i /><i /><i /></span>
      </main>
    );
  } else if (!room.view) {
    page = <Home room={room} user={auth.user} onLogout={auth.logout} />;
  } else if (room.view.status === 'waiting') {
    page = <Lobby view={room.view} onLeave={() => void room.leave()} />;
  } else {
    page = <GamePage key={room.view.roomId} room={room} />;
  }

  return (
    <>
      <Ambience mood={myTurn ? 'turn' : 'calm'} />
      {page}
      {room.view && <Social key={room.view.roomId} view={room.view} />}
    </>
  );
}
