import { CHAIN } from "./chain";
import { formatAmount } from "./preflight";
import type { PreflightResult, Row } from "./types";

/**
 * A fingerprint of exactly what would be sent: network, token and every
 * address and amount, in order. Two people who get the same fingerprint are
 * looking at the same list.
 */
export async function fingerprint(rows: Row[], token: string | undefined, decimals: number): Promise<string> {
  const lines = rows.map((r) => `${(r.address ?? r.rawAddress.trim()).toLowerCase()},${r.amount?.toString() ?? ""}`);
  const text = [`chain:${CHAIN.id}`, `token:${(token ?? "").trim().toLowerCase()}`, `decimals:${decimals}`, ...lines].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VERDICT_TEXT = {
  stop: "Do not sign. Fix the rows marked Stop first.",
  check: "Review the rows marked Check before signing.",
  clear: "No problems found by these checks.",
} as const;

const LABEL = { stop: "Stop", check: "Check", clear: "Clear", info: "Note" } as const;

export interface ReportContext {
  sender?: string;
  token?: string;
  fingerprint: string;
  generatedAt: Date;
}

export function buildReport(result: PreflightResult, ctx: ReportContext): string {
  const unit = result.symbol ? ` ${result.symbol}` : "";
  const out: string[] = [];
  out.push("# Payout preflight report", "");
  out.push(`**${VERDICT_TEXT[result.verdict]}**`, "");
  out.push(`- Network: ${CHAIN.name} (chain ${CHAIN.id})`);
  out.push(`- Generated: ${ctx.generatedAt.toISOString()}`);
  if (ctx.sender?.trim()) out.push(`- Sender: \`${ctx.sender.trim()}\``);
  if (ctx.token?.trim()) out.push(`- Token: \`${ctx.token.trim()}\`${result.symbol ? ` (${result.symbol})` : ""}, ${result.decimals} decimals`);
  out.push(`- Recipients: ${result.rows.length}`);
  out.push(`- Total: ${formatAmount(result.total, result.decimals)}${unit}`);
  out.push(`- Rows: ${result.counts.stop} stop, ${result.counts.check} check, ${result.counts.clear} clear`);
  out.push(`- On-chain checks: ${result.onchainRan ? "ran" : "did not run"}`);
  out.push(`- Sender history checks: ${result.historyRan ? "ran" : "did not run"}`);
  out.push(`- List fingerprint (SHA-256): \`${ctx.fingerprint}\``, "");
  out.push(
    "Signers: run the same list through the checker yourself. If your fingerprint differs from the one above, you are not looking at the list this report describes.",
    "",
  );

  if (result.listFindings.length) {
    out.push("## Whole-list findings", "");
    for (const f of result.listFindings) out.push(`- **${LABEL[f.severity]}: ${f.title}.** ${f.detail}`);
    out.push("");
  }

  const flagged = result.rows.filter((r) => r.status !== "clear");
  out.push(`## Rows needing attention (${flagged.length})`, "");
  if (!flagged.length) out.push("None.", "");
  for (const row of flagged) {
    const amount = row.amount !== undefined ? `${formatAmount(row.amount, result.decimals)}${unit}` : row.rawAmount || "no amount";
    out.push(`### Line ${row.line}: ${LABEL[row.status]}`, "");
    out.push(`\`${row.address ?? row.rawAddress}\`, ${amount}`, "");
    for (const f of row.findings) {
      out.push(`- **${LABEL[f.severity]}: ${f.title}.** ${f.detail}${f.related ? ` Compared with \`${f.related}\`.` : ""}`);
    }
    out.push("");
  }

  out.push("## Full list", "", "| Line | Address | Amount | Status |", "| --- | --- | --- | --- |");
  for (const row of result.rows) {
    const amount = row.amount !== undefined ? formatAmount(row.amount, result.decimals) : row.rawAmount;
    out.push(`| ${row.line} | \`${row.address ?? row.rawAddress}\` | ${amount} | ${LABEL[row.status]} |`);
  }
  out.push("");

  out.push("## What this report does not cover", "");
  out.push("- It cannot tell whether an address belongs to the person you think it does. Only the recipient can confirm that.");
  out.push(`- It reads ${CHAIN.name} only. An address that is a wallet here can be something else on another network.`);
  out.push("- It checks the list, not the transaction. Signers still need to confirm the transaction they sign carries this list.");
  out.push("- A clear result means these specific checks found nothing, not that the payout is safe.");
  out.push("");
  return out.join("\n");
}
