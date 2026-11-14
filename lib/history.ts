/** Shapes of the Etherscan `txlist` and `tokentx` records we rely on. */
export interface NormalTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
}

export interface TokenTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenDecimal?: string;
}

export interface ClassifiedHistory {
  paid: Set<string>;
  suspicious: Set<string>;
}

const lower = (s: string | undefined) => (s ?? "").toLowerCase();

function isDust(value: bigint, decimals: number): boolean {
  // Less than one hundredth of a whole token.
  const d = BigInt(Math.max(0, decimals - 2));
  return value < 10n ** d;
}

/**
 * Splits a sender's history into addresses it really paid and addresses that
 * only show up through the tricks address poisoners use.
 *
 * "Really paid" means value left the sender in a transaction that the sender
 * took part in at the top level: it signed it, or (for a Safe or other
 * contract wallet) the transaction was sent to it. A poisoner can make a fake
 * token emit a Transfer "from" the sender, or call transferFrom with zero
 * value on a real token, but those transactions are sent by the attacker to a
 * token contract, so they never appear in the sender's own transaction list.
 */
export function classifyHistory(sender: string, txs: NormalTx[], tokenTxs: TokenTx[]): ClassifiedHistory {
  const me = lower(sender);
  const paid = new Set<string>();
  const contacts = new Set<string>();
  const ownHashes = new Set<string>();

  for (const tx of txs) {
    if (tx.isError === "1") continue;
    ownHashes.add(lower(tx.hash));
    const from = lower(tx.from);
    const to = lower(tx.to);
    let value = 0n;
    try {
      value = BigInt(tx.value || "0");
    } catch {}
    if (from === me && to && to !== me && value > 0n) paid.add(to);
    else if (to === me && from !== me && (value === 0n || isDust(value, 18))) contacts.add(from);
  }

  for (const t of tokenTxs) {
    const from = lower(t.from);
    const to = lower(t.to);
    let value = 0n;
    try {
      value = BigInt(t.value || "0");
    } catch {}
    const decimals = Number(t.tokenDecimal ?? "18") || 18;

    if (from === me && to && to !== me) {
      if (value > 0n && ownHashes.has(lower(t.hash))) paid.add(to);
      else contacts.add(to); // zero-value, or a Transfer the sender never took part in
    } else if (to === me && from && from !== me) {
      if (value === 0n || isDust(value, decimals)) contacts.add(from);
    }
  }

  const suspicious = new Set<string>();
  for (const a of contacts) if (!paid.has(a)) suspicious.add(a);
  return { paid, suspicious };
}
