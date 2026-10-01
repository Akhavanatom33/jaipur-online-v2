import { useEffect, useMemo, useRef, useState } from 'react';
import type { TurnTimerView } from '../../../shared/types.ts';
import { MAX_MISSED_TURNS } from '../../../shared/constants.ts';
import { play } from '../game/sound.ts';

const R = 19;
const C = 2 * Math.PI * R;

interface Props {
  turn: TurnTimerView | null;
  /** Is it the local player's turn? Only then does the clock tick out loud. */
  mine: boolean;
  /** Consecutive missed turns of the player whose turn it is. */
  missed: number;
}

/**
 * Countdown ring for the current turn. The server owns the clock; we only
 * display it. `serverNow` lets us correct for a wrong device clock.
 */
export function TurnTimer({ turn, mine, missed }: Props) {
  const offset = useMemo(() => (turn ? turn.serverNow - Date.now() : 0), [turn]);
  const [, force] = useState(0);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    if (!turn) return;
    const id = setInterval(() => force((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [turn]);

  const remaining = turn ? Math.max(0, turn.deadline - (Date.now() + offset)) : 0;
  const secs = Math.ceil(remaining / 1000);
  const frac = turn ? Math.min(1, remaining / turn.durationMs) : 0;

  useEffect(() => {
    if (!turn || !mine) return;
    if (secs <= 10 && secs > 0 && lastTick.current !== secs) play('tick');
    lastTick.current = secs;
  }, [secs, mine, turn]);

  if (!turn) return null;
  const tone = secs <= 10 ? 'danger' : secs <= 20 ? 'warn' : 'calm';

  return (
    <span
      className={`timer timer--${tone} ${mine ? 'timer--mine' : ''}`}
      role="timer"
      aria-label={`${secs} seconds left`}
      title={missed > 0 ? `${missed} of ${MAX_MISSED_TURNS} missed turns. Miss ${MAX_MISSED_TURNS} in a row and you forfeit.` : 'Move before the clock runs out or you lose the turn.'}
    >
      <svg className="timer__ring" viewBox="0 0 44 44" aria-hidden>
        <circle className="timer__track" cx="22" cy="22" r={R} />
        <circle className="timer__arc" cx="22" cy="22" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <span className="timer__num">{secs}</span>
      <span className="timer__pips" aria-hidden>
        {Array.from({ length: MAX_MISSED_TURNS }, (_, i) => <i key={i} className={i < missed ? 'is-on' : ''} />)}
      </span>
      <span className="timer__fuse" aria-hidden><b style={{ transform: `scaleX(${frac})` }} /></span>
    </span>
  );
}
