import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RoomView } from '../../../shared/types.ts';
import { CHAT_MAX_LENGTH } from '../../../shared/protocol.ts';
import { useChat } from '../hooks/useChat.ts';
import { useVoice } from '../hooks/useVoice.ts';
import '../styles/social.css';

const fmtTime = (at: number) => {
  try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

/**
 * Chat + voice dock. Lives in the bottom-left corner while you are in a room
 * (lobby or game). Mounted with key={roomId}, so leaving a room releases the
 * microphone and clears the chat.
 */
export function Social({ view }: { view: RoomView }) {
  const { messages, send } = useChat(view.roomId);
  const voice = useVoice(view.you);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(0);

  const listRef = useRef<HTMLOListElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const lastId = messages.length ? messages[messages.length - 1].id : 0;

  // History that arrives when you (re)join the room is not "unread".
  useEffect(() => {
    const t = setTimeout(() => {
      const list = messagesRef.current;
      if (list.length) setSeenId((s) => Math.max(s, list[list.length - 1].id));
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // While the panel is open everything counts as read.
  useEffect(() => { if (open && lastId) setSeenId(lastId); }, [open, lastId]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (open && el) el.scrollTo({ top: el.scrollHeight });
  }, [open, lastId]);

  const unread = open ? 0 : messages.filter((m) => m.id > seenId && m.seat !== view.you).length;

  const name = (seat: number) => view.players[seat]?.name ?? `Player ${seat + 1}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || sending) return;
    setSending(true);
    setError(null);
    const err = await send(clean);
    setSending(false);
    if (err) setError(err);
    else setText('');
  };

  return (
    <div className="sx-dock" data-open={open ? 'true' : 'false'}>
      {open && (
        <section className="sx-panel" role="dialog" aria-label="Room chat">
          <header className="sx-panel__head">
            <strong>Chat</strong>
            <span className="sx-panel__room">Room {view.roomId}</span>
            <button type="button" className="sx-icon" onClick={() => setOpen(false)} aria-label="Close chat">✕</button>
          </header>

          {voice.active && voice.seats.length > 0 && (
            <ul className="sx-voice-list" aria-label="In voice">
              {voice.seats.map((s) => (
                <li key={s} className={`sx-voice-chip ${voice.speaking.includes(s) ? 'is-speaking' : ''} ${s === view.you || voice.linked.includes(s) ? 'is-linked' : ''}`}>
                  <i aria-hidden />
                  {name(s)}{s === view.you ? ' (you)' : ''}
                </li>
              ))}
            </ul>
          )}

          <ol className="sx-messages" ref={listRef} aria-live="polite">
            {messages.length === 0 && <li className="sx-empty">No messages yet. Say hello 👋</li>}
            {messages.map((m) => (
              <li key={m.id} className={`sx-msg ${m.seat === view.you ? 'is-mine' : ''}`}>
                <div className="sx-msg__meta">
                  <b>{m.seat === view.you ? 'You' : m.name}</b>
                  <time>{fmtTime(m.at)}</time>
                </div>
                <p className="sx-msg__text" dir="auto">{m.text}</p>
              </li>
            ))}
          </ol>

          {error && <p className="sx-error" role="alert">{error}</p>}

          <form className="sx-form" onSubmit={submit}>
            <input
              className="sx-input"
              value={text}
              onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
              maxLength={CHAT_MAX_LENGTH}
              placeholder="Write a message…"
              dir="auto"
              autoComplete="off"
              enterKeyHint="send"
              aria-label="Message"
            />
            <button type="submit" className="sx-send" disabled={sending || !text.trim()}>Send</button>
          </form>
        </section>
      )}

      <div className="sx-bar">
        <button type="button" className={`sx-btn ${open ? 'is-on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span aria-hidden>💬</span> Chat
          {unread > 0 && <span className="sx-badge" aria-label={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>}
        </button>

        {!voice.active ? (
          <button
            type="button"
            className="sx-btn"
            onClick={() => void voice.join()}
            disabled={!voice.supported || voice.busy}
            title={voice.supported ? 'Talk to the other players' : 'Voice chat needs a modern browser and HTTPS'}
          >
            <span aria-hidden>🎙</span> {voice.busy ? 'Connecting…' : 'Join voice'}
          </button>
        ) : (
          <>
            <button type="button" className={`sx-btn ${voice.muted ? 'is-muted' : 'is-live'}`} onClick={voice.toggleMute} aria-pressed={voice.muted}>
              <span aria-hidden>{voice.muted ? '🔇' : '🎙'}</span> {voice.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="sx-btn sx-btn--leave" onClick={voice.leave}>
              <span aria-hidden>⏻</span> Leave voice
            </button>
            <span className="sx-status" title="Players in voice / connected audio links">
              {voice.seats.length} in voice
            </span>
          </>
        )}
      </div>

      {voice.error && <p className="sx-error sx-error--floating" role="alert">{voice.error}</p>}
    </div>
  );
}
