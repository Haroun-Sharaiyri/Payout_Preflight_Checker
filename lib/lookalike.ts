import type { Severity } from "./types";

export interface Similarity {
  /** Matching hex characters at the start, after 0x. */
  prefix: number;
  /** Matching hex characters at the end. */
  suffix: number;
}

const body = (address: string) => address.slice(2).toLowerCase();

export function similarity(a: string, b: string): Similarity {
  const x = body(a);
  const y = body(b);
  let prefix = 0;
  while (prefix < 40 && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < 40 - prefix && x[39 - suffix] === y[39 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * Wallets shorten addresses to their first and last few characters, so
 * poisoners grind addresses that match exactly there. Two different addresses
 * agreeing on four characters at both ends happens by chance about once in
 * four billion pairs.
 */
export function classify(sim: Similarity): Extract<Severity, "stop" | "check"> | null {
  const { prefix, suffix } = sim;
  if (prefix === 40) return null; // identical
  if ((prefix >= 4 && suffix >= 4) || prefix >= 8 || suffix >= 8) return "stop";
  if ((prefix >= 3 && suffix >= 3) || prefix >= 6 || suffix >= 6) return "check";
  return null;
}

export interface LookalikeHit {
  other: string;
  severity: "stop" | "check";
  sim: Similarity;
}

/** The closest lookalike of `address` in `candidates`, ignoring exact matches. */
export function closestLookalike(address: string, candidates: Iterable<string>): LookalikeHit | null {
  let best: LookalikeHit | null = null;
  const self = address.toLowerCase();
  for (const other of candidates) {
    if (other.toLowerCase() === self) continue;
    const sim = similarity(address, other);
    const severity = classify(sim);
    if (!severity) continue;
    const score = sim.prefix + sim.suffix + (severity === "stop" ? 100 : 0);
    const bestScore = best ? best.sim.prefix + best.sim.suffix + (best.severity === "stop" ? 100 : 0) : -1;
    if (score > bestScore) best = { other, severity, sim };
  }
  return best;
}
