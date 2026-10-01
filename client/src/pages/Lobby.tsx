import { useState } from 'react';
import type { RoomView } from '../../../shared/types.ts';
import { GoodIcon } from '../components/Icons.tsx';

export function Lobby({ view, onLeave }: { view: RoomView; onLeave: () => void }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const missing = view.players.filter((p) => p === null).length;
  const link = `${location.origin}${location.pathname}?room=${view.roomId}`;

  const copy = async (what: 'code' | 'link') => {
    const text = what === 'code' ? view.roomId : link;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <main className="lobby">
      <p className="eyebrow">Your room is open</p>
      <h1 className="lobby__title">Share this code</h1>
      <div className="code" aria-label={`Room code ${view.roomId.split('').join(' ')}`}>
        {view.roomId.split('').map((ch, i) => <span key={i} className="code__tile" style={{ ['--i' as string]: i }}>{ch}</span>)}
      </div>
      <div className="lobby__copy">
        <button type="button" className="btn btn--primary" onClick={() => copy('code')}>{copied === 'code' ? 'Copied ✓' : 'Copy code'}</button>
        <button type="button" className="btn btn--ghost" onClick={() => copy('link')}>{copied === 'link' ? 'Link copied ✓' : 'Copy invite link'}</button>
      </div>

      <div className="caravan" aria-hidden>
        <div className="caravan__dunes" />
        <div className="caravan__walkers">{[0, 1, 2].map((i) => <span key={i}><GoodIcon type="camel" /></span>)}</div>
      </div>

      <ol className="slots">
        {view.players.map((p, i) => p ? (
          <li key={i} className="slot is-filled"><span className="slot__n">{i + 1}</span><span>{p.name}{i === view.you ? ' (you)' : ''}</span><span className="muted">{i === 0 ? 'host' : p.connected ? 'ready' : 'offline'}</span></li>
        ) : (
          <li key={i} className="slot is-waiting"><span className="slot__n">{i + 1}</span><span>Waiting for player<span className="dots"><i>.</i><i>.</i><i>.</i></span></span></li>
        ))}
      </ol>
      <p className="lobby__note">{view.mode}-player game · {missing === 1 ? 'one more player to go.' : `${missing} more players to go.`} It starts the moment the last seat is taken. Use chat or voice while you wait.</p>
      <button type="button" className="btn btn--link" onClick={onLeave}>Close room</button>
    </main>
  );
}
