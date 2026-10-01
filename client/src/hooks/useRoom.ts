import { useCallback, useEffect, useRef, useState } from 'react';
import type { AckResult, SeatGrant } from '../../../shared/protocol.ts';
import type { GameAction, GameMode, RoomView } from '../../../shared/types.ts';
import { api, socket } from '../net/socket.ts';
import { session } from '../net/storage.ts';

const SESSION_KEY = 'jaipur.seat';
type Session = { roomId: string; token: string };
const loadSession = (): Session | null => {
  try { return JSON.parse(session.get(SESSION_KEY) ?? 'null'); } catch { return null; }
};
const saveSession = (s: SeatGrant) => session.set(SESSION_KEY, JSON.stringify({ roomId: s.roomId, token: s.token }));
const clearSession = () => session.remove(SESSION_KEY);

export interface RoomApi {
  view: RoomView | null;
  connected: boolean;
  restoring: boolean;
  notice: string | null;
  create: (mode?: GameMode) => Promise<AckResult<SeatGrant>>;
  join: (code: string) => Promise<AckResult<SeatGrant>>;
  leave: () => Promise<void>;
  act: (action: GameAction) => Promise<AckResult>;
  continueGame: () => Promise<AckResult>;
  dismissNotice: () => void;
}

export function useRoom(enabled: boolean): RoomApi {
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [restoring, setRestoring] = useState(() => enabled && loadSession() !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasView = useRef(false);

  useEffect(() => {
    if (!enabled) {
      socket.stop();
      setConnected(false);
      setRestoring(false);
      setView(null);
      return;
    }
    setRestoring(loadSession() !== null);
    socket.start();
    const onState = (v: RoomView) => { hasView.current = true; setView(v); };
    const onConnect = () => {
      setConnected(true);
      const s = loadSession();
      if (!s) { setRestoring(false); return; }
      api.rejoin(s.roomId, s.token).then((res) => {
        setRestoring(false);
        if (!res.ok) {
          clearSession();
          if (hasView.current) setNotice(res.error);
          hasView.current = false;
          setView(null);
        }
      });
    };
    const onDisconnect = () => setConnected(false);
    socket.on('room:state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off('room:state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [enabled]);

  const create = useCallback(async (mode: GameMode = 2) => {
    const res = await api.create(mode);
    if (res.ok) saveSession(res);
    return res;
  }, []);

  const join = useCallback(async (code: string) => {
    const res = await api.join(code);
    if (res.ok) saveSession(res);
    return res;
  }, []);

  const leave = useCallback(async () => {
    clearSession();
    hasView.current = false;
    setView(null);
    await api.leave();
  }, []);

  return {
    view, connected, restoring, notice,
    create, join, leave,
    act: api.act,
    continueGame: api.continueGame,
    dismissNotice: () => setNotice(null),
  };
}
