import type { PlayerIndex, ScoreBreakdown, SealDecider } from '../../shared/types.ts';
import { CAMEL_TOKEN_VALUE } from '../../shared/constants.ts';
import type { PlayerState, RoundState } from './state.ts';

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/** Camel token: the single biggest herd takes it; a tie for first place means nobody does. */
export function camelMajority(round: RoundState): PlayerIndex | null {
  const counts = round.players.map((p) => p.herd.length);
  const max = Math.max(...counts);
  if (counts.filter((c) => c === max).length !== 1) return null;
  return counts.indexOf(max) as PlayerIndex;
}

export function scorePlayer(p: PlayerState, hasCamelToken: boolean): ScoreBreakdown {
  const goods = sum(p.goodsTokens.map((t) => t.value));
  const bonus = sum(p.bonusTokens.map((t) => t.value));
  const camel = hasCamelToken ? CAMEL_TOKEN_VALUE : 0;
  return {
    goods,
    bonus,
    camel,
    total: goods + bonus + camel,
    goodsTokenCount: p.goodsTokens.length,
    bonusTokenCount: p.bonusTokens.length,
    camels: p.herd.length,
    goodsTokens: p.goodsTokens.slice(),
    bonusTokens: p.bonusTokens.slice(),
  };
}

/**
 * Seal of Excellence: richest trader. Ties -> most bonus tokens -> most goods tokens.
 * The rulebook defines nothing beyond that; a perfect tie for first place awards no seal ("unbroken").
 * `eligible` lets the caller exclude seats that forfeited.
 */
export function decideSealAmong(
  scores: readonly ScoreBreakdown[],
  eligible: readonly boolean[] = scores.map(() => true),
): { winner: PlayerIndex | null; decidedBy: SealDecider } {
  const steps: [SealDecider, (s: ScoreBreakdown) => number][] = [
    ['rupees', (s) => s.total],
    ['bonusCount', (s) => s.bonusTokenCount],
    ['goodsCount', (s) => s.goodsTokenCount],
  ];
  let pool = scores.map((_, i) => i).filter((i) => eligible[i]);
  if (pool.length === 0) return { winner: null, decidedBy: 'unbroken' };
  for (const [name, get] of steps) {
    const best = Math.max(...pool.map((i) => get(scores[i])));
    const top = pool.filter((i) => get(scores[i]) === best);
    if (top.length === 1) return { winner: top[0] as PlayerIndex, decidedBy: name };
    // Only the leaders go on to the next tie-breaker.
    pool = top;
  }
  return { winner: null, decidedBy: 'unbroken' };
}

/** Two-player convenience wrapper (used by the original tests). */
export function decideSeal(a: ScoreBreakdown, b: ScoreBreakdown): { winner: PlayerIndex | null; decidedBy: SealDecider } {
  return decideSealAmong([a, b]);
}
