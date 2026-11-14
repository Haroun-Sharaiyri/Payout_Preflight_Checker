export type Severity = "stop" | "check" | "info";
export type RowStatus = "stop" | "check" | "clear";

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Another address this finding compares against (drives the diff view). */
  related?: string;
}

export interface Row {
  /** 1-based line number in the pasted list. */
  line: number;
  rawAddress: string;
  /** Checksummed address, present only when the address is well formed. */
  address?: `0x${string}`;
  rawAmount: string;
  /** Amount in the token's base units, present only when it parsed. */
  amount?: bigint;
  findings: Finding[];
  status: RowStatus;
}

export type AccountKind = "eoa" | "contract" | "delegated";

export interface RecipientFacts {
  kind: AccountKind;
  nonce: number;
  balanceWei: string;
}

export interface TokenFacts {
  address: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  senderBalance?: string;
}

export interface HistoryFacts {
  available: boolean;
  /** Why history is missing, in words fit for the page. */
  reason?: string;
  /** Addresses the sender has really sent value to. Lowercase. */
  paid: string[];
  /** Addresses whose only contact with the sender is zero-value, dust or spoofed transfers. Lowercase. */
  suspicious: string[];
  truncated: boolean;
}

export interface OnchainFacts {
  recipients: Record<string, RecipientFacts>;
  token?: TokenFacts;
  history?: HistoryFacts;
  /** Recipients beyond the on-chain cap that were not looked up. */
  skipped: number;
  errors: string[];
}

export interface PreflightInput {
  list: string;
  sender?: string;
  token?: string;
  decimals: number;
  expectedTotal?: string;
  trusted?: string;
  onchain?: OnchainFacts;
}

export interface PreflightResult {
  rows: Row[];
  listFindings: Finding[];
  counts: { stop: number; check: number; clear: number };
  /** Sum of all parsed amounts, in base units. */
  total: bigint;
  decimals: number;
  symbol?: string;
  verdict: RowStatus;
  onchainRan: boolean;
  historyRan: boolean;
}
