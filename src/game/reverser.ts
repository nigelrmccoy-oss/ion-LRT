/** Cab reverser cycle: Neutral → Forward → Reverse → Neutral. */
export type ReverserPos = -1 | 0 | 1;

const ORDER: ReverserPos[] = [0, 1, -1];

/** Advance one step on R key. Fixes v1.2 bug where N jumped to Reverse. */
export function nextReverser(current: ReverserPos): ReverserPos {
  const i = ORDER.indexOf(current);
  const idx = i < 0 ? 0 : i;
  return ORDER[(idx + 1) % ORDER.length]!;
}

export function reverserLabel(r: ReverserPos): string {
  return r > 0 ? 'F' : r < 0 ? 'R' : 'N';
}
