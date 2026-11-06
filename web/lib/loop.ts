export const MAX_LEVERAGE = 4;
/// Each round borrows this share of what the collateral still allows, to stay clear of liquidation.
export const ROUND_SHARE = 0.9;
export const MAX_ROUNDS = 8;

/// Rounds of borrow, swap and add collateral needed to reach `leverage` on a market with `lltv`.
export function loopRounds(leverage: number, lltv: number): number {
  let collateral = 1;
  let debt = 0;
  let remaining = leverage - 1;
  let rounds = 0;
  while (remaining > 1e-6 && rounds < MAX_ROUNDS) {
    const borrow = Math.min(remaining, (collateral * lltv - debt) * ROUND_SHARE);
    debt += borrow;
    collateral += borrow;
    remaining -= borrow;
    rounds++;
  }
  return remaining > 1e-6 ? Infinity : rounds;
}

/// How far the collateral price can fall before the loan hits its liquidation LTV.
export const liquidationDrop = (leverage: number, lltv: number) => 1 - (leverage - 1) / leverage / lltv;
