/**
 * The authoritative Jaipur engine. Pure game logic with no I/O: it mutates a
 * GameState after validating every action with the shared rule checks.
 *
 * Supports 2 players (classic), 3 players (Trio) and 4 players (Grand Bazaar).
 */
import type { BonusSize, Card, CardType, GameAction, GameActionType, GameMode, GoodType, LogBody, PlayerIndex, RoundEndReason } from '../../shared/types.ts';
import { DEPLETED_TYPES_TO_END, GOODS, MAX_MARKET_SIZE, MULTI_MAX_ROUNDS, SEALS_TO_WIN } from '../../shared/constants.ts';
import { bonusSizeFor, checkExchange, checkSell, checkTakeCamels, checkTakeGood, type Check } from '../../shared/rules.ts';
import { modeConfig } from '../../shared/constants.ts';
import { cryptoRng, type Rng } from './rng.ts';
import { createRound } from './setup.ts';
import { camelMajority, decideSealAmong, scorePlayer } from './scoring.ts';
import { modeOf, nextSeat, type GameState, type RoundState } from './state.ts';

export type EngineResult = { ok: true } | { ok: false; error: string };

const MAX_LOG = 250;

function pushLog(state: GameState, body: LogBody) {
  state.log.push({ ...body, id: state.nextLogId++ } as GameState['log'][number]);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function event(state: GameState, player: PlayerIndex, type: GameActionType | 'roundStart' | 'timeout') {
  state.lastEvent = { seq: (state.lastEvent?.seq ?? 0) + 1, player, type };
}

/** Rounds after which the game must end (3 and 4 players only). */
export const maxRoundsFor = (mode: GameMode): number | null => (mode > 2 ? MULTI_MAX_ROUNDS : null);

export function createGame(rng: Rng = cryptoRng, startingPlayer?: PlayerIndex, mode: GameMode = 2): GameState {
  // "Pick a starting player": chosen at random.
  const starter: PlayerIndex = startingPlayer ?? (Math.floor(rng() * mode) as PlayerIndex);
  const state: GameState = {
    phase: 'playing',
    mode,
    round: createRound(1, starter, rng, mode),
    seals: Array.from({ length: mode }, () => 0),
    results: [],
    winner: null,
    forfeit: null,
    out: Array.from({ length: mode }, () => false),
    log: [],
    nextLogId: 1,
    lastEvent: null,
    version: 1,
  };
  pushLog(state, { kind: 'roundStart', round: 1, starter });
  event(state, starter, 'roundStart');
  return state;
}

export function depletedTypes(round: RoundState): number {
  return GOODS.filter((g) => round.goodsTokens[g].length === 0).length;
}

// ---------------------------------------------------------------------------
// Input parsing: never trust the shape of client data.
// ---------------------------------------------------------------------------

const isStrArray = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length < 64);

export function parseAction(raw: unknown): GameAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case 'takeGood':
      return typeof a.cardId === 'string' ? { type: 'takeGood', cardId: a.cardId } : null;
    case 'takeCamels':
      return { type: 'takeCamels' };
    case 'exchange':
      if (!isStrArray(a.takeIds, MAX_MARKET_SIZE) || !isStrArray(a.giveIds, MAX_MARKET_SIZE)) return null;
      if (typeof a.giveCamels !== 'number' || !Number.isInteger(a.giveCamels) || a.giveCamels < 0 || a.giveCamels > MAX_MARKET_SIZE) return null;
      return { type: 'exchange', takeIds: a.takeIds.slice(), giveIds: a.giveIds.slice(), giveCamels: a.giveCamels };
    case 'sell':
      return isStrArray(a.cardIds, 20) ? { type: 'sell', cardIds: a.cardIds.slice() } : null;
    default:
      return null;
  }
}

export function validateAction(state: GameState, player: PlayerIndex, action: GameAction): Check {
  const r = state.round;
  const me = r.players[player];
  const limit = modeConfig(modeOf(state)).handLimit;
  switch (action.type) {
    case 'takeGood': return checkTakeGood(r.market, me.hand, action.cardId, limit);
    case 'takeCamels': return checkTakeCamels(r.market);
    case 'exchange': return checkExchange(r.market, me.hand, me.herd, action.takeIds, action.giveIds, action.giveCamels, limit);
    case 'sell': return checkSell(me.hand, action.cardIds);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function applyAction(state: GameState, player: PlayerIndex, raw: unknown): EngineResult {
  if (state.phase !== 'playing') return { ok: false, error: 'The round is over.' };
  if (player !== state.round.currentPlayer) return { ok: false, error: "It's not your turn." };
  const action = parseAction(raw);
  if (!action) return { ok: false, error: 'Malformed action.' };
  const check = validateAction(state, player, action);
  if (!check.ok) return { ok: false, error: check.reason };

  const r = state.round;
  const me = r.players[player];

  switch (action.type) {
    case 'takeGood': {
      const idx = r.market.findIndex((c) => c.id === action.cardId);
      const card = r.market[idx];
      me.hand.push(card);
      const slots: (Card | null)[] = r.market.slice();
      slots[idx] = null;
      pushLog(state, { kind: 'takeGood', player, good: card.type as GoodType });
      event(state, player, 'takeGood');
      refillMarket(state, slots);
      break;
    }
    case 'takeCamels': {
      const camels = r.market.filter((c) => c.type === 'camel');
      me.herd.push(...camels);
      const slots = r.market.map((c) => (c.type === 'camel' ? null : c));
      pushLog(state, { kind: 'takeCamels', player, count: camels.length });
      event(state, player, 'takeCamels');
      refillMarket(state, slots);
      break;
    }
    case 'exchange': {
      const given: Card[] = action.giveIds.map((id) => me.hand.find((c) => c.id === id)!);
      me.hand = me.hand.filter((c) => !action.giveIds.includes(c.id));
      given.push(...me.herd.splice(me.herd.length - action.giveCamels, action.giveCamels));
      const took: GoodType[] = [];
      let g = 0;
      // Returned cards take the exact market slots that were emptied.
      r.market = r.market.map((c) => {
        if (!action.takeIds.includes(c.id)) return c;
        me.hand.push(c);
        took.push(c.type as GoodType);
        return given[g++];
      });
      pushLog(state, { kind: 'exchange', player, took, gave: given.map((c) => c.type as CardType) });
      event(state, player, 'exchange');
      break;
    }
    case 'sell': {
      const cards = me.hand.filter((c) => action.cardIds.includes(c.id));
      const good = cards[0].type as GoodType;
      me.hand = me.hand.filter((c) => !action.cardIds.includes(c.id));
      r.discard.push(...cards);
      // Take tokens from the top of the stack; if the stack runs out you simply get fewer.
      const tokens = r.goodsTokens[good].splice(0, cards.length);
      me.goodsTokens.push(...tokens);
      // The bonus is still awarded even when goods tokens ran short.
      const size: BonusSize | null = bonusSizeFor(cards.length);
      let bonus: BonusSize | null = null;
      if (size && r.bonusStacks[size].length > 0) {
        me.bonusTokens.push(r.bonusStacks[size].shift()!);
        bonus = size;
      }
      pushLog(state, {
        kind: 'sell', player, good, count: cards.length,
        rupees: tokens.reduce((s, t) => s + t.value, 0), tokens: tokens.length, bonus,
      });
      event(state, player, 'sell');
      if (depletedTypes(r) >= DEPLETED_TYPES_TO_END) endRound(state, 'tokens');
      break;
    }
  }

  if (state.phase === 'playing') r.currentPlayer = nextSeat(state, player);
  state.version++;
  return { ok: true };
}

/** The clock ran out: the player loses this turn and the next player moves. */
export function skipTurn(state: GameState, player: PlayerIndex, missed: number): EngineResult {
  if (state.phase !== 'playing') return { ok: false, error: 'The round is over.' };
  if (player !== state.round.currentPlayer) return { ok: false, error: "It's not that player's turn." };
  pushLog(state, { kind: 'timeout', player, missed });
  event(state, player, 'timeout');
  state.round.currentPlayer = nextSeat(state, player);
  state.version++;
  return { ok: true };
}

/**
 * A player who keeps missing turns (or leaves) loses.
 * 2 players: the game ends at once and the opponent wins.
 * 3-4 players: the player is out (skipped from now on); the game goes on until
 * only one player is left, who then wins.
 */
export function forfeitGame(state: GameState, loser: PlayerIndex): EngineResult {
  if (state.phase === 'gameOver') return { ok: false, error: 'The game is already over.' };
  const n = state.round.players.length;
  state.out ??= Array.from({ length: n }, () => false);
  if (state.out[loser]) return { ok: true };
  state.out[loser] = true;
  pushLog(state, { kind: 'forfeit', loser });
  const active = state.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  if (active.length <= 1) {
    const winner = (active[0] ?? nextSeat(state, loser)) as PlayerIndex;
    state.phase = 'gameOver';
    state.winner = winner;
    state.forfeit = loser;
    state.seals[winner] = Math.max(state.seals[winner], SEALS_TO_WIN);
    pushLog(state, { kind: 'gameEnd', winner });
  } else if (state.phase === 'playing' && state.round.currentPlayer === loser) {
    state.round.currentPlayer = nextSeat(state, loser);
  }
  state.version++;
  return { ok: true };
}

/** Fill empty slots from the deck. If the deck cannot fill the market, the round ends. */
function refillMarket(state: GameState, slots: (Card | null)[]) {
  const r = state.round;
  let short = false;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]) continue;
    const next = r.deck.shift();
    if (next) slots[i] = next;
    else short = true;
  }
  r.market = slots.filter((c): c is Card => c !== null);
  if (short) endRound(state, 'deck');
}

export function endRound(state: GameState, reason: RoundEndReason) {
  const r = state.round;
  const mode = modeOf(state);
  r.endReason = reason;
  const camelWinner = camelMajority(r);
  if (camelWinner !== null) r.camelTokenAvailable = false;
  const scores = r.players.map((p, i) => scorePlayer(p, camelWinner === i));
  const eligible = r.players.map((_, i) => !state.out?.[i]);
  const { winner, decidedBy } = decideSealAmong(scores, eligible);
  if (winner !== null) state.seals[winner]++;
  state.results.push({
    round: r.number, reason, scores, camelWinner, sealWinner: winner, decidedBy,
    sealsAfter: state.seals.slice(),
  });
  pushLog(state, { kind: 'roundEnd', round: r.number, reason });
  pushLog(state, { kind: 'camelToken', player: camelWinner });
  pushLog(state, { kind: 'seal', player: winner, decidedBy });

  if (winner !== null && state.seals[winner] >= SEALS_TO_WIN) {
    state.phase = 'gameOver';
    state.winner = winner;
    pushLog(state, { kind: 'gameEnd', winner });
    return;
  }
  const cap = maxRoundsFor(mode);
  if (cap !== null && state.results.length >= cap) {
    // Nobody reached 2 seals: most seals wins, then the most rupees over all rounds.
    const totals = r.players.map((_, i) => state.results.reduce((s, res) => s + res.scores[i].total, 0));
    const live = r.players.map((_, i) => i).filter((i) => !state.out?.[i]);
    live.sort((a, b) => state.seals[b] - state.seals[a] || totals[b] - totals[a] || a - b);
    state.phase = 'gameOver';
    state.winner = live[0] as PlayerIndex;
    pushLog(state, { kind: 'gameEnd', winner: state.winner });
    return;
  }
  state.phase = 'roundOver';
}

/** Next round: full new setup; the player after the seal winner starts (the loser in a 2-player game). */
export function startNextRound(state: GameState, rng: Rng = cryptoRng): EngineResult {
  if (state.phase !== 'roundOver') return { ok: false, error: 'The round is not over.' };
  const last = state.results[state.results.length - 1];
  // No seal (a perfect tie, not covered by the rulebook): the next seat after the last starter begins.
  const starter = last.sealWinner !== null ? nextSeat(state, last.sealWinner) : nextSeat(state, state.round.startingPlayer);
  const number = state.round.number + 1;
  state.round = createRound(number, starter, rng, modeOf(state));
  state.phase = 'playing';
  pushLog(state, { kind: 'roundStart', round: number, starter });
  event(state, starter, 'roundStart');
  state.version++;
  return { ok: true };
}

/** Fresh game after a finished one. The previous game's loser starts. */
export function createRematch(prev: GameState, rng: Rng = cryptoRng): GameState {
  const mode = modeOf(prev);
  const starter = prev.winner !== null ? nextSeat({ ...prev, out: [] }, prev.winner) : undefined;
  const next = createGame(rng, starter, mode);
  next.version = prev.version + 1;
  next.lastEvent = { seq: (prev.lastEvent?.seq ?? 0) + 1, player: next.round.startingPlayer, type: 'roundStart' };
  return next;
}
