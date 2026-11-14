import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { closestLookalike } from "./lookalike";
import { extractAddresses, parseList } from "./parse";
import type { Finding, PreflightInput, PreflightResult, Row, RowStatus } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);
const HIDDEN_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00A0]/g;
const HAS_HIDDEN_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00A0]/;


export function formatAmount(value: bigint, decimals: number): string {
  const s = formatUnits(value, decimals);
  const [whole, frac] = s.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function checkAddress(raw: string, findings: Finding[]): `0x${string}` | undefined {
  let value = raw.trim();
  if (HAS_HIDDEN_CHARS.test(value)) {
    value = value.replace(HIDDEN_CHARS, "");
    findings.push({
      code: "HIDDEN_CHARACTERS",
      severity: "check",
      title: "Hidden characters removed",
      detail: "The address contained invisible characters, which usually means it was copied from a chat or a document. Re-copy it from the source.",
    });
  }

  if (value === "") {
    findings.push({ code: "MISSING_ADDRESS", severity: "stop", title: "No address", detail: "This row has no recipient address." });
    return;
  }
  if (/\.eth$/i.test(value)) {
    findings.push({
      code: "ENS_NAME",
      severity: "stop",
      title: "ENS name, not an address",
      detail: "Names are not resolved here. Replace it with the 0x address so signers see exactly where the tokens go.",
    });
    return;
  }
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    findings.push({
      code: "NOT_AN_ADDRESS",
      severity: "stop",
      title: "Not an address",
      detail: "An address is 0x followed by 40 hex characters (0-9, a-f).",
    });
    return;
  }
  if (value.length !== 42) {
    findings.push({
      code: "WRONG_LENGTH",
      severity: "stop",
      title: "Wrong length",
      detail: `This has ${value.length - 2} hex characters after 0x; an address has exactly 40. Characters were lost or added when copying.`,
    });
    return;
  }

  const hex = value.slice(2);
  const singleCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (singleCase) {
    if (/[a-fA-F]/.test(hex)) {
      findings.push({
        code: "NO_CHECKSUM",
        severity: "check",
        title: "No checksum",
        detail: "The address is all one case, so a mistyped character cannot be detected. Ask for the mixed-case version copied from a wallet or explorer.",
      });
    }
  } else if (!isAddress(value, { strict: true })) {
    findings.push({
      code: "BAD_CHECKSUM",
      severity: "stop",
      title: "Checksum fails",
      detail: "The upper and lower case letters do not match this address, which means at least one character is wrong. Get the address again from the recipient.",
    });
    return;
  }
  return getAddress(value);
}

function checkAmount(raw: string, decimals: number, findings: Finding[]): bigint | undefined {
  let value = raw.trim().replace(HIDDEN_CHARS, "");
  if (value === "") {
    findings.push({ code: "MISSING_AMOUNT", severity: "stop", title: "No amount", detail: "This row has no amount." });
    return;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) {
    value = value.replace(/,/g, "");
    findings.push({
      code: "THOUSANDS_SEPARATORS",
      severity: "check",
      title: "Commas read as thousands separators",
      detail: `Read as ${value}. Confirm the commas were not meant as decimal points.`,
    });
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    findings.push({
      code: "AMOUNT_NOT_A_NUMBER",
      severity: "stop",
      title: "Amount is not a plain number",
      detail: "Use digits with an optional decimal point, in whole tokens (for example 1500.25).",
    });
    return;
  }
  const fraction = value.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    findings.push({
      code: "TOO_MANY_DECIMALS",
      severity: "stop",
      title: "More decimal places than the token has",
      detail: `The token has ${decimals} decimals; this amount uses ${fraction.length}. It cannot be sent exactly.`,
    });
    return;
  }
  const amount = parseUnits(value, decimals);
  if (amount === 0n) {
    findings.push({ code: "ZERO_AMOUNT", severity: "check", title: "Zero amount", detail: "This row sends nothing." });
  }
  // A whole-number amount with more digits than the token has decimals is
  // almost always base units (wei) pasted where whole tokens were expected.
  if (decimals >= 9 && !value.includes(".") && value.replace(/^0+/, "").length > decimals) {
    const asWei = formatAmount(BigInt(value), decimals);
    findings.push({
      code: "LOOKS_LIKE_BASE_UNITS",
      severity: "stop",
      title: "Amount looks like base units",
      detail: `Amounts here are whole tokens, so this row sends ${formatAmount(amount, decimals)} tokens. If the number is in base units (wei), the intended amount is ${asWei}.`,
    });
  }
  return amount;
}

const worst = (findings: Finding[]): RowStatus =>
  findings.some((f) => f.severity === "stop") ? "stop" : findings.some((f) => f.severity === "check") ? "check" : "clear";

/**
 * Runs every check on a recipient list. Pure: on-chain facts are passed in,
 * so the same function serves the instant offline pass and the full pass.
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const onchain = input.onchain;
  const decimals = onchain?.token?.decimals ?? input.decimals;
  const symbol = onchain?.token?.symbol;
  const listFindings: Finding[] = [];
  const parsed = parseList(input.list);

  if (parsed.error) {
    listFindings.push({ code: "UNREADABLE_LIST", severity: "stop", title: "The list could not be read", detail: parsed.error });
  }

  const sender = input.sender && isAddress(input.sender.trim()) ? input.sender.trim().toLowerCase() : undefined;
  const token = input.token && isAddress(input.token.trim()) ? input.token.trim().toLowerCase() : undefined;
  if (input.sender?.trim() && !sender) {
    listFindings.push({ code: "BAD_SENDER", severity: "check", title: "Sender address is not valid", detail: "Sender checks were skipped. Fix the sender address and run again." });
  }
  if (input.token?.trim() && !token) {
    listFindings.push({ code: "BAD_TOKEN", severity: "check", title: "Token address is not valid", detail: "Token checks were skipped. Fix the token address and run again." });
  }

  const trusted = new Set(extractAddresses(input.trusted ?? "").map((a) => a.toLowerCase()));
  const paid = new Set(onchain?.history?.available ? onchain.history.paid : []);
  const suspicious = new Set(onchain?.history?.available ? onchain.history.suspicious : []);
  const known = new Set<string>([...trusted, ...paid]);

  const hasAmounts = parsed.rows.some((p) => p.amount.trim() !== "");
  if (!parsed.error && !hasAmounts) {
    listFindings.push({
      code: "NO_AMOUNTS",
      severity: "info",
      title: "Addresses only",
      detail: "The list has no amount column, so amount checks were skipped.",
    });
  }

  const rows: Row[] = parsed.rows.map((p) => {
    const findings: Finding[] = [];
    const address = checkAddress(p.address, findings);
    const amount = hasAmounts ? checkAmount(p.amount, decimals, findings) : undefined;
    return { line: p.line, rawAddress: p.address, address, rawAmount: p.amount, amount, findings, status: "clear" };
  });

  // Group rows by address for duplicate and lookalike checks.
  const byAddress = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.address) continue;
    const key = row.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), row]);
  }
  const unique = [...byAddress.keys()];

  for (const [key, group] of byAddress) {
    const address = group[0].address!;
    const add = (f: Finding) => group.forEach((r) => r.findings.push(f));

    if (BURN.has(key)) {
      add({ code: "BURN_ADDRESS", severity: "stop", title: key === ZERO ? "Zero address" : "Burn address", detail: "Tokens sent here are gone for good." });
    }
    if (token && key === token) {
      add({ code: "TOKEN_CONTRACT", severity: "stop", title: "This is the token contract itself", detail: "Tokens sent to their own contract are almost always locked forever." });
    }
    if (sender && key === sender) {
      add({ code: "SENDER_IN_LIST", severity: "check", title: "This is the sender", detail: "The sending wallet is paying itself." });
    }

    if (group.length > 1) {
      const total = group.reduce((sum, r) => sum + (r.amount ?? 0n), 0n);
      group.forEach((r) =>
        r.findings.push({
          code: "DUPLICATE",
          severity: "check",
          title: "Listed more than once",
          detail: `Also on line ${group.filter((g) => g !== r).map((g) => g.line).join(", ")}. Combined, this address receives ${formatAmount(total, decimals)}.`,
        }),
      );
    }

    // Lookalike of an address the sender already trusts or has paid.
    const isKnown = known.has(key);
    const knownHit = isKnown ? null : closestLookalike(address, known);
    if (knownHit) {
      const source = paid.has(knownHit.other.toLowerCase()) ? "an address this sender has paid before" : "an address on your trusted list";
      add({
        code: "LOOKALIKE_OF_KNOWN",
        severity: knownHit.severity,
        title: "Looks like a known address, but is not it",
        detail: `Starts and ends like ${source} (${knownHit.sim.prefix} matching characters at the start, ${knownHit.sim.suffix} at the end) but differs in the middle. This is what an address-poisoning swap looks like.`,
        related: getAddress(knownHit.other),
      });
    }

    // Lookalike of another row in the same list.
    const listHit = closestLookalike(address, unique);
    if (listHit && listHit.other.toLowerCase() !== knownHit?.other.toLowerCase()) {
      const otherLines = byAddress.get(listHit.other.toLowerCase())!.map((r) => r.line).join(", ");
      add(
        isKnown
          ? {
              code: "HAS_LOOKALIKE_IN_LIST",
              severity: "check",
              title: "A lookalike of this address is in the list",
              detail: `Line ${otherLines} starts and ends like this address but is a different one. This one matches your records; look hard at the other.`,
              related: getAddress(listHit.other),
            }
          : {
              code: "LOOKALIKE_IN_LIST",
              severity: listHit.severity,
              title: "Looks like another address in this list",
              detail: `Starts and ends like the address on line ${otherLines} but is a different address. One of the two is probably a wrong paste or a planted copy.`,
              related: getAddress(listHit.other),
            },
      );
    }

    if (suspicious.has(key) && !isKnown) {
      add({
        code: "POISONING_SIGNATURE",
        severity: knownHit ? "stop" : "check",
        title: "Only prior contact is a zero-value or dust transfer",
        detail: "The sender has never really paid this address. It appears in the sender's history only through a zero-value, dust or spoofed transfer, which is how poisoners plant addresses to be copied later.",
      });
    }
    if (paid.has(key)) {
      add({ code: "PAID_BEFORE", severity: "info", title: "Paid before", detail: "The sender has sent value to this exact address before." });
    } else if (trusted.has(key)) {
      add({ code: "TRUSTED", severity: "info", title: "On your trusted list", detail: "Matches a trusted address exactly." });
    }

    const facts = onchain?.recipients[key];
    if (facts && !BURN.has(key) && key !== token) {
      if (facts.kind === "contract") {
        add({
          code: "CONTRACT_RECIPIENT",
          severity: "check",
          title: "Contract, not a wallet",
          detail: "There is contract code at this address on Sepolia. Confirm it is meant to hold these tokens (a Safe, a vesting contract) and can move them out again.",
        });
      } else if (facts.kind === "delegated") {
        add({
          code: "DELEGATED_ACCOUNT",
          severity: "info",
          title: "Wallet with delegated code",
          detail: "A normal wallet that has delegated to a smart-account contract (EIP-7702).",
        });
      } else if (facts.nonce === 0 && facts.balanceWei === "0" && !paid.has(key)) {
        add({
          code: "NEVER_USED",
          severity: "check",
          title: "Never used on Sepolia",
          detail: "No outgoing transactions and no ETH. Nothing shows that anyone controls this address. Confirm it with the recipient on a second channel, or send a small test amount first.",
        });
      }
    }
  }

  // Amount checks across the whole list.
  const amounts = rows.map((r) => r.amount).filter((a): a is bigint => a !== undefined && a > 0n);
  const total = rows.reduce((sum, r) => sum + (r.amount ?? 0n), 0n);

  if (amounts.length >= 5) {
    const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const row of rows) {
      if (row.amount !== undefined && median > 0n && row.amount >= median * 100n && !row.findings.some((f) => f.code === "LOOKS_LIKE_BASE_UNITS")) {
        row.findings.push({
          code: "AMOUNT_OUTLIER",
          severity: "check",
          title: "Far larger than the rest",
          detail: `This amount is at least 100 times the typical row (${formatAmount(median, decimals)}). Check for extra zeros or a misplaced decimal point.`,
        });
      }
    }
  }

  const expected = input.expectedTotal?.trim().replace(/,/g, "");
  if (expected) {
    if (!/^\d+(\.\d+)?$/.test(expected) || (expected.split(".")[1] ?? "").length > decimals) {
      listFindings.push({ code: "BAD_EXPECTED_TOTAL", severity: "check", title: "Expected total is not a valid number", detail: "The total comparison was skipped." });
    } else {
      const want = parseUnits(expected, decimals);
      if (want !== total) {
        const diff = total > want ? total - want : want - total;
        listFindings.push({
          code: "TOTAL_MISMATCH",
          severity: "stop",
          title: "The list does not add up to the expected total",
          detail: `The rows sum to ${formatAmount(total, decimals)}; you expected ${formatAmount(want, decimals)}. The list is ${total > want ? "over" : "under"} by ${formatAmount(diff, decimals)}.`,
        });
      }
    }
  }

  const tokenFacts = onchain?.token;
  if (tokenFacts?.totalSupply !== undefined) {
    const supply = BigInt(tokenFacts.totalSupply);
    if (total > supply) {
      listFindings.push({
        code: "EXCEEDS_SUPPLY",
        severity: "stop",
        title: "The list sends more than the token's entire supply",
        detail: `Rows sum to ${formatAmount(total, decimals)} but only ${formatAmount(supply, decimals)} exist. The amounts are almost certainly in the wrong unit.`,
      });
    } else {
      for (const row of rows) {
        if (row.amount !== undefined && row.amount > supply) {
          row.findings.push({ code: "ROW_EXCEEDS_SUPPLY", severity: "stop", title: "More than the entire supply", detail: "This single row is larger than the token's total supply." });
        }
      }
    }
  }
  if (tokenFacts?.senderBalance !== undefined && sender) {
    const balance = BigInt(tokenFacts.senderBalance);
    if (total > balance) {
      listFindings.push({
        code: "SENDER_SHORT",
        severity: "check",
        title: "The sender holds less than the list total",
        detail: `The sender holds ${formatAmount(balance, decimals)} and the list needs ${formatAmount(total, decimals)}. Fine if the wallet is funded before sending; otherwise the batch will fail.`,
      });
    }
  }

  if (onchain?.skipped) {
    listFindings.push({
      code: "ONCHAIN_PARTIAL",
      severity: "check",
      title: "Some addresses were not looked up on Sepolia",
      detail: `${onchain.skipped} addresses were beyond the on-chain limit for one run. Their offline checks still ran. Split the list to cover them.`,
    });
  }
  if (onchain?.history?.truncated) {
    listFindings.push({
      code: "HISTORY_TRUNCATED",
      severity: "info",
      title: "Only the sender's most recent history was read",
      detail: "The sender has more transactions than one lookup returns, so older payments may be missing from the paid-before check.",
    });
  }

  let stop = 0;
  let check = 0;
  let clear = 0;
  const rank = { stop: 0, check: 1, info: 2 } as const;
  for (const row of rows) {
    row.findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    row.status = worst(row.findings);
    if (row.status === "stop") stop++;
    else if (row.status === "check") check++;
    else clear++;
  }
  const listStatus = worst(listFindings);
  const verdict: RowStatus = stop > 0 || listStatus === "stop" ? "stop" : check > 0 || listStatus === "check" ? "check" : "clear";

  return {
    rows,
    listFindings,
    counts: { stop, check, clear },
    total,
    decimals,
    symbol,
    verdict,
    onchainRan: Boolean(onchain),
    historyRan: Boolean(onchain?.history?.available),
  };
}
