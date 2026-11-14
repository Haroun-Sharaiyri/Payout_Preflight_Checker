import { NextResponse } from "next/server";
import { createPublicClient, erc20Abi, fallback, http, isAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { CHAIN, ONCHAIN_LIMIT } from "@/lib/chain";
import { classifyHistory, type NormalTx, type TokenTx } from "@/lib/history";
import type { AccountKind, HistoryFacts, OnchainFacts, RecipientFacts, TokenFacts } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const PUBLIC_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://rpc.sepolia.org",
];

const HISTORY_PAGE = 5000;

function client() {
  const urls = [process.env.SEPOLIA_RPC_URL, ...PUBLIC_RPCS].filter((u): u is string => Boolean(u));
  return createPublicClient({
    chain: sepolia,
    transport: fallback(
      urls.map((url) => http(url, { batch: { batchSize: 50 }, timeout: 10_000, retryCount: 1 })),
    ),
  });
}

function accountKind(code: string | undefined): AccountKind {
  if (!code || code === "0x") return "eoa";
  // EIP-7702: a wallet that delegates to contract code carries 0xef0100 + address.
  if (code.toLowerCase().startsWith("0xef0100") && code.length === 48) return "delegated";
  return "contract";
}

async function readRecipients(rpc: ReturnType<typeof client>, addresses: Address[]) {
  const facts: Record<string, RecipientFacts> = {};
  let failed = 0;
  const CHUNK = 40;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(async (address) => {
        const [code, nonce, balance] = await Promise.all([
          rpc.getCode({ address }),
          rpc.getTransactionCount({ address }),
          rpc.getBalance({ address }),
        ]);
        return { address, code, nonce, balance };
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") {
        facts[s.value.address.toLowerCase()] = {
          kind: accountKind(s.value.code),
          nonce: s.value.nonce,
          balanceWei: s.value.balance.toString(),
        };
      } else failed++;
    }
  }
  return { facts, failed };
}

async function readToken(rpc: ReturnType<typeof client>, token: Address, sender: Address | undefined, errors: string[]) {
  const code = await rpc.getCode({ address: token }).catch(() => undefined);
  if (code === undefined) {
    errors.push("The token contract could not be read from Sepolia.");
    return undefined;
  }
  if (code === "0x") {
    errors.push("There is no contract at the token address on Sepolia. Check the address and the network.");
    return undefined;
  }
  const read = <T,>(p: Promise<T>) => p.catch(() => undefined);
  const [decimals, symbol, totalSupply, senderBalance] = await Promise.all([
    read(rpc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
    read(rpc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
    read(rpc.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" })),
    sender ? read(rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [sender] })) : undefined,
  ]);
  if (decimals === undefined) {
    errors.push("The token address does not answer like an ERC-20 token (no decimals). Amounts use the decimals you entered.");
  }
  const facts: TokenFacts = {
    address: token,
    symbol: typeof symbol === "string" ? symbol.slice(0, 16) : undefined,
    decimals: typeof decimals === "number" ? decimals : undefined,
    totalSupply: totalSupply?.toString(),
    senderBalance: senderBalance?.toString(),
  };
  return facts;
}

async function etherscan<T>(action: string, address: string, apiKey: string): Promise<T[]> {
  const url = new URL(process.env.ETHERSCAN_API_URL || "https://api.etherscan.io/v2/api");
  url.search = new URLSearchParams({
    chainid: String(CHAIN.id),
    module: "account",
    action,
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(HISTORY_PAGE),
    sort: "desc",
    apikey: apiKey,
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!res.ok) throw new Error(`Etherscan answered with HTTP ${res.status}.`);
  const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
  if (Array.isArray(body.result)) return body.result as T[];
  const text = `${body.message ?? ""} ${typeof body.result === "string" ? body.result : ""}`.toLowerCase();
  if (text.includes("no transactions found")) return [];
  if (text.includes("invalid api key") || text.includes("missing")) throw new Error("Etherscan rejected the API key. Check ETHERSCAN_API_KEY.");
  if (text.includes("rate limit")) throw new Error("Etherscan rate limit reached. Wait a few seconds and run again.");
  throw new Error("Etherscan returned an error for the sender's history.");
}

async function readHistory(sender: Address): Promise<HistoryFacts> {
  const empty = { paid: [], suspicious: [], truncated: false };
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return { available: false, reason: "No Etherscan API key is set on the server, so the sender's history was not read.", ...empty };
  }
  try {
    const txs = await etherscan<NormalTx>("txlist", sender, apiKey);
    const tokenTxs = await etherscan<TokenTx>("tokentx", sender, apiKey);
    const { paid, suspicious } = classifyHistory(sender, txs, tokenTxs);
    return {
      available: true,
      paid: [...paid],
      suspicious: [...suspicious],
      truncated: txs.length >= HISTORY_PAGE || tokenTxs.length >= HISTORY_PAGE,
    };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : "The sender's history could not be read.", ...empty };
  }
}

export async function POST(request: Request) {
  let body: { recipients?: unknown; sender?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The request was not valid JSON." }, { status: 400 });
  }

  const all = Array.isArray(body.recipients) ? body.recipients : [];
  const unique = [...new Set(all.filter((a): a is string => typeof a === "string" && isAddress(a)).map((a) => a.toLowerCase()))] as Address[];
  if (unique.length === 0) {
    return NextResponse.json({ error: "No valid recipient addresses to look up." }, { status: 400 });
  }
  const addresses = unique.slice(0, ONCHAIN_LIMIT);
  const sender = typeof body.sender === "string" && isAddress(body.sender) ? (body.sender as Address) : undefined;
  const token = typeof body.token === "string" && isAddress(body.token) ? (body.token as Address) : undefined;

  const rpc = client();
  const errors: string[] = [];

  const [recipients, tokenFacts, history] = await Promise.all([
    readRecipients(rpc, addresses),
    token ? readToken(rpc, token, sender, errors) : undefined,
    sender ? readHistory(sender) : undefined,
  ]);

  if (Object.keys(recipients.facts).length === 0) {
    return NextResponse.json(
      { error: "Sepolia could not be reached from the server. The public endpoints may be down or rate limited; set SEPOLIA_RPC_URL to a private endpoint or try again." },
      { status: 502 },
    );
  }
  if (recipients.failed > 0) {
    errors.push(`${recipients.failed} of ${addresses.length} addresses could not be read from Sepolia and have no on-chain checks.`);
  }

  const facts: OnchainFacts = {
    recipients: recipients.facts,
    token: tokenFacts,
    history,
    skipped: unique.length - addresses.length,
    errors,
  };
  return NextResponse.json(facts);
}
