// Oversold dip rider — a long-only cbBTC/USDC bot for the make.fun 24h BTC race.
//
// Idea: on a slow, choppy 1-minute tape the tape spends most of its time drifting
// a few basis points a bar, then makes one- to two-hour legs of 100-200 bps in
// either direction. This bot does nothing while the tape is flat and buys the
// whole cash balance only after a sharp one-hour wash-out, then sells into the
// recovery. One position at a time, full size, no leverage, no shorts.
//
//   BUY  when the 60-bar return is at or below -110 bps (close now vs the close
//        60 bars ago), provided the pool is not unusually shallow: the latest
//        close depth must be at least 50% of the median of the previous 240
//        bars' close depths. Exits are never blocked by the depth guard.
//   SELL at +160 bps above the entry close (take profit) or at -60 bps below
//        it (stop). Nothing else exits a trade; the replay flattens any open
//        position at the end of the window.
//
// All arithmetic is integer BigInt math in basis points, truncated the same way
// in every run, so two executions on the same bars answer identically. No
// clock, no randomness, no network, no files outside this repository.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BARS = 60;
const OVERSOLD_BPS = -110;
const TAKE_PROFIT_BPS = 160;
const STOP_BPS = -60;
const DEPTH_WINDOW = 240;
const DEPTH_MIN_PCT = 50;
const MAX_SLIPPAGE_BPS = 100;

// History of closes and close-depths, oldest first, one entry per batch seen.
const closes: bigint[] = [];
const depths: bigint[] = [];

// Our own bookkeeping for the open trade. `holding` is confirmed against the
// account each batch (see the sync step in onBatch); `entryClose` is the close
// of the bar on which the buy was decided.
let holding = false;
let entryClose = 0n;
let buyDecidedSeq = -1;

/** Floor-division basis-point return (now - then) / then * 10000. BigInt `/`
 *  truncates toward zero, so a negative numerator with a remainder needs one
 *  step down to match floor division. Prices are always positive. */
function returnBps(now: bigint, then: bigint): bigint {
  const num = (now - then) * 10000n;
  const q = num / then;
  const r = num % then;
  return r !== 0n && num < 0n ? q - 1n : q;
}

/** Lower median of a list of depths (the element at index (n - 1) / 2 of the
 *  sorted list). For the 240-bar window that is index 119. */
function lowerMedian(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[(sorted.length - 1) >> 1];
}

await runBars({
  onBatch(state) {
    // Warm-up batches cannot trade: every order on one is rejected, so wait.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);
    const depth = state.depthAt(SYMBOL);
    depths.push(depth === null ? 0n : depth[0]);

    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : pos.qty;

    // Sync the open-trade flag with the account. A buy decided on the previous
    // batch fills at this batch's open, so allow one batch of lag before
    // concluding a buy was rejected and the flag should clear.
    if (qty > 0n) {
      holding = true;
      if (entryClose === 0n) entryClose = close;
    } else if (holding && buyDecidedSeq >= 0 && state.seq - buyDecidedSeq <= 1) {
      // Fill still in flight; keep the flag until the next batch confirms.
    } else {
      holding = false;
      entryClose = 0n;
      buyDecidedSeq = -1;
    }

    // --- Exits: only while a position is actually held. ---
    if (holding && qty > 0n) {
      const gain = returnBps(close, entryClose);
      if (gain >= TAKE_PROFIT_BPS || gain <= STOP_BPS) {
        holding = false;
        entryClose = 0n;
        buyDecidedSeq = -1;
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
      return [];
    }

    // --- Entries: only when flat, with enough history for the 60-bar return. ---
    // closes[length - 61] is the close 60 bars ago (length counts the bar just
    // pushed), so this is the return over the last 60 bars, endpoints included.
    if (closes.length <= LOOKBACK_BARS) return [];
    const hourAgo = closes[closes.length - LOOKBACK_BARS - 1];
    if (returnBps(close, hourAgo) > OVERSOLD_BPS) return [];

    // Pool-depth guard: skip the buy when the pool at this close is thinner
    // than half the median depth of the previous 240 bars. The guard needs a
    // full 240-bar depth history; before that, buys are allowed.
    if (depths.length > DEPTH_WINDOW) {
      // The 240 depths before this bar's own: indices length-241 .. length-2.
      const prev = depths.slice(depths.length - DEPTH_WINDOW - 1, depths.length - 1);
      const median = lowerMedian(prev);
      if (median > 0n && depths[depths.length - 1] * 100n < BigInt(DEPTH_MIN_PCT) * median) {
        return [];
      }
    }

    // Full-size buy with the whole cash balance. The replay caps the weight
    // and rejects anything below the minimum notional; our cash is the full
    // $1,000 start (plus realised gains), far above both.
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    holding = true;
    entryClose = close;
    buyDecidedSeq = state.seq;
    const buy: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: cash,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    return [buy];
  },
});
