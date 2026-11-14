import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { classifyHistory } from "@/lib/history";
import { classify, similarity } from "@/lib/lookalike";
import { extractAddresses, parseList } from "@/lib/parse";
import { runPreflight } from "@/lib/preflight";
import { fingerprint } from "@/lib/report";
import { buildSample } from "@/lib/sample";
import type { OnchainFacts } from "@/lib/types";

const A = getAddress("0x5aeda56215b167893e80b4fe645ba6d5bab767de");
const B = getAddress("0x6330a553fc93768f612722bb8c2ec78ac90b3bbc");
const C = getAddress("0xb9c5714089478a327f09197987f16f9e5d936e8a");
const REAL = getAddress("0xc41d8e2f7a9b3c5d6e0f1a2b3c4d5e6f7a8b9c0d");
// First four and last four characters match REAL; the middle differs.
const FAKE = getAddress("0xc41d5b7e02c94f3a81d6e7b093a52c68f14d9c0d");

const codes = (r: ReturnType<typeof runPreflight>, line: number) =>
  r.rows.find((row) => row.line === line)!.findings.map((f) => f.code);

describe("list parsing", () => {
  it("reads a plain address,amount list without a header", () => {
    const p = parseList(`${A},100\n${B},200.5\n`);
    expect(p.hadHeader).toBe(false);
    expect(p.rows).toEqual([
      { line: 1, address: A, amount: "100" },
      { line: 2, address: B, amount: "200.5" },
    ]);
  });

  it("reads the Safe CSV Airdrop layout by header name", () => {
    const p = parseList(`token_type,token_address,receiver,amount,id\nerc20,${C},${A},42,\n`);
    expect(p.rows).toEqual([{ line: 2, address: A, amount: "42" }]);
  });

  it("handles semicolons, tabs, quotes and blank lines", () => {
    expect(parseList(`wallet;amount\n\n${A};7\n`).rows[0]).toEqual({ line: 3, address: A, amount: "7" });
    expect(parseList(`${A}\t9\n`).rows[0].amount).toBe("9");
    expect(parseList(`address,amount\n${A},"1,000"\n`).rows[0].amount).toBe("1,000");
  });

  it("reports an empty list and a missing address column", () => {
    expect(parseList("  \n").error).toBeTruthy();
    expect(parseList("name,amount\nbob,5\n").error).toMatch(/address column/);
  });

  it("extracts addresses from free text", () => {
    expect(extractAddresses(`treasury: ${A}\n${B} (advisor)`)).toEqual([A, B]);
  });
});

describe("lookalike scoring", () => {
  it("measures matching characters at both ends", () => {
    expect(similarity(REAL, FAKE)).toEqual({ prefix: 4, suffix: 4 });
    expect(similarity(REAL, REAL).prefix).toBe(40);
  });

  it("stops on a 4+4 match, ignores unrelated and identical addresses", () => {
    expect(classify(similarity(REAL, FAKE))).toBe("stop");
    expect(classify(similarity(A, B))).toBeNull();
    expect(classify(similarity(A, A))).toBeNull();
    expect(classify({ prefix: 3, suffix: 3 })).toBe("check");
    expect(classify({ prefix: 0, suffix: 8 })).toBe("stop");
    expect(classify({ prefix: 2, suffix: 2 })).toBeNull();
  });
});

describe("address checks", () => {
  it("passes a clean list", () => {
    const r = runPreflight({ list: `${A},100\n${B},200\n`, decimals: 18 });
    expect(r.verdict).toBe("clear");
    expect(r.counts).toEqual({ stop: 0, check: 0, clear: 2 });
    expect(r.total).toBe(300n * 10n ** 18n);
  });

  it("stops on a failed checksum, wrong length, junk, ENS and burn addresses", () => {
    const badChecksum = A.slice(0, 2) + (A[2] === A[2].toLowerCase() ? A.slice(2).toUpperCase().slice(0, 1) : A[2].toLowerCase()) + A.slice(3);
    const mixed = /[a-f]/.test(badChecksum.slice(2)) && /[A-F]/.test(badChecksum.slice(2));
    const list = [
      `${mixed ? badChecksum : A.slice(0, 41) + (A[41] === "e" ? "E" : "e")},1`,
      `${A.slice(0, 41)},1`,
      `0xZZZ,1`,
      `vitalik.eth,1`,
      `0x0000000000000000000000000000000000000000,1`,
      `0x000000000000000000000000000000000000dEaD,1`,
    ].join("\n");
    const r = runPreflight({ list, decimals: 18 });
    expect(codes(r, 2)).toContain("WRONG_LENGTH");
    expect(codes(r, 3)).toContain("NOT_AN_ADDRESS");
    expect(codes(r, 4)).toContain("ENS_NAME");
    expect(codes(r, 5)).toContain("BURN_ADDRESS");
    expect(codes(r, 6)).toContain("BURN_ADDRESS");
    expect(r.verdict).toBe("stop");
  });

  it("catches a single flipped-case character via the checksum", () => {
    const sample = buildSample();
    const r = runPreflight({ list: sample.list, decimals: 18 });
    expect(r.rows.some((row) => row.findings.some((f) => f.code === "BAD_CHECKSUM"))).toBe(true);
  });

  it("warns on all-lowercase addresses and strips hidden characters", () => {
    const r = runPreflight({ list: `${A.toLowerCase()},1\n\u200B${B},1\n`, decimals: 18 });
    expect(codes(r, 1)).toEqual(["NO_CHECKSUM"]);
    expect(codes(r, 2)).toEqual(["HIDDEN_CHARACTERS"]);
    expect(r.rows[1].address).toBe(B);
    // Running twice must give the same answer (guards against regex state).
    const again = runPreflight({ list: `\u200B${B},1\n\u200B${A},1\n`, decimals: 18 });
    expect(again.rows.every((row) => row.findings[0]?.code === "HIDDEN_CHARACTERS")).toBe(true);
  });

  it("flags duplicates with the combined amount, and the token and sender as recipients", () => {
    const r = runPreflight({ list: `${A},100\n${B},5\n${A},50\n${C},1\n`, decimals: 18, token: C, sender: B });
    expect(codes(r, 1)).toContain("DUPLICATE");
    expect(r.rows[0].findings[0].detail).toMatch(/line 3/);
    expect(r.rows[0].findings[0].detail).toMatch(/150/);
    expect(codes(r, 2)).toContain("SENDER_IN_LIST");
    expect(codes(r, 4)).toContain("TOKEN_CONTRACT");
  });
});

describe("lookalike checks", () => {
  it("stops a swapped address that mimics a trusted one (the GUA pattern)", () => {
    const r = runPreflight({ list: `${A},100\n${FAKE},7500000\n`, decimals: 18, trusted: `multisig destination: ${REAL}` });
    const finding = r.rows[1].findings.find((f) => f.code === "LOOKALIKE_OF_KNOWN")!;
    expect(finding.severity).toBe("stop");
    expect(finding.related).toBe(REAL);
    expect(r.rows[1].status).toBe("stop");
    expect(r.rows[0].status).toBe("clear");
    expect(r.verdict).toBe("stop");
  });

  it("does not flag the trusted address itself", () => {
    const r = runPreflight({ list: `${REAL},100\n`, decimals: 18, trusted: REAL });
    expect(codes(r, 1)).toEqual(["TRUSTED"]);
    expect(r.verdict).toBe("clear");
  });

  it("flags two lookalikes inside one list, pointing each at the other", () => {
    const r = runPreflight({ list: `${REAL},1\n${A},1\n${FAKE},1\n`, decimals: 18 });
    expect(r.rows[0].findings[0]).toMatchObject({ code: "LOOKALIKE_IN_LIST", severity: "stop", related: FAKE });
    expect(r.rows[2].findings[0]).toMatchObject({ code: "LOOKALIKE_IN_LIST", severity: "stop", related: REAL });
    expect(r.rows[1].status).toBe("clear");
  });

  it("keeps the red flag on the impostor when the real one is trusted and both are listed", () => {
    const r = runPreflight({ list: `${REAL},1\n${FAKE},1\n`, decimals: 18, trusted: REAL });
    expect(r.rows[0].status).toBe("check");
    expect(codes(r, 1)).toContain("HAS_LOOKALIKE_IN_LIST");
    expect(r.rows[1].status).toBe("stop");
    expect(codes(r, 2)).toEqual(["LOOKALIKE_OF_KNOWN"]);
  });
});

describe("amount checks", () => {
  it("stops on base units pasted as whole tokens", () => {
    const r = runPreflight({ list: `${A},15000000000000000000000\n`, decimals: 18 });
    const f = r.rows[0].findings.find((x) => x.code === "LOOKS_LIKE_BASE_UNITS")!;
    expect(f.severity).toBe("stop");
    expect(f.detail).toMatch(/intended amount is 15,000/);
  });

  it("does not treat large 6-decimal amounts as base units", () => {
    const r = runPreflight({ list: `${A},25000000\n`, decimals: 6 });
    expect(r.verdict).toBe("clear");
  });

  it("stops on junk, negative and over-precise amounts; notes zero and thousands separators", () => {
    const r = runPreflight({ list: `a,b\n${A},abc\n${B},-5\n${C},1.1234567\n${REAL},0\n${FAKE},"1,000"\n`.replace("a,b", "address,amount"), decimals: 6 });
    expect(codes(r, 2)).toContain("AMOUNT_NOT_A_NUMBER");
    expect(codes(r, 3)).toContain("AMOUNT_NOT_A_NUMBER");
    expect(codes(r, 4)).toContain("TOO_MANY_DECIMALS");
    expect(codes(r, 5)).toContain("ZERO_AMOUNT");
    expect(codes(r, 6)).toContain("THOUSANDS_SEPARATORS");
    expect(r.rows[4].amount).toBe(1000n * 10n ** 6n);
  });

  it("stops when the list does not add up to the expected total", () => {
    const ok = runPreflight({ list: `${A},100\n${B},200\n`, decimals: 18, expectedTotal: "300" });
    expect(ok.listFindings).toEqual([]);
    const bad = runPreflight({ list: `${A},100\n${B},2000\n`, decimals: 18, expectedTotal: "300" });
    expect(bad.listFindings[0]).toMatchObject({ code: "TOTAL_MISMATCH", severity: "stop" });
    expect(bad.listFindings[0].detail).toMatch(/over by 1,800/);
    expect(bad.verdict).toBe("stop");
  });

  it("flags a row 100x the typical amount", () => {
    const filler = [A, B, C, REAL].map((a) => `${a},100`).join("\n");
    const other = getAddress("0xe11ba2b4d45eaed5996cd0823791e0c93114882d");
    const r = runPreflight({ list: `${filler}\n${other},10000\n`, decimals: 18 });
    expect(codes(r, 5)).toContain("AMOUNT_OUTLIER");
    expect(codes(r, 1)).not.toContain("AMOUNT_OUTLIER");
  });

  it("skips amount checks for an address-only list", () => {
    const r = runPreflight({ list: `${A}\n${B}\n`, decimals: 18 });
    expect(r.rows.every((row) => row.findings.length === 0)).toBe(true);
    expect(r.listFindings[0].code).toBe("NO_AMOUNTS");
    expect(r.verdict).toBe("clear");
  });
});

describe("sender history", () => {
  const sender = getAddress("0x7a3f9c2e5b8d41f0a6c3e9b2d5f8a1c4e7b0d3f6");
  const tokenAddr = getAddress("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");

  it("separates real payments from zero-value, dust and spoofed transfers", () => {
    const h = classifyHistory(
      sender,
      [
        { hash: "0x01", from: sender, to: tokenAddr, value: "0", isError: "0" }, // sender calls token.transfer
        { hash: "0x02", from: sender, to: A, value: "1000000000000000000", isError: "0" }, // sends 1 ETH to A
        { hash: "0x03", from: sender, to: C, value: "5", isError: "1" }, // failed, ignored
      ],
      [
        { hash: "0x01", from: sender, to: REAL, value: "5000000", tokenDecimal: "6" }, // real payment to REAL
        { hash: "0xaa", from: sender, to: FAKE, value: "0", tokenDecimal: "6" }, // zero-value transferFrom spoof
        { hash: "0xbb", from: sender, to: B, value: "5000000", tokenDecimal: "6" }, // fake token, sender never took part
        { hash: "0xcc", from: C, to: sender, value: "1", tokenDecimal: "6" }, // inbound dust
      ],
    );
    expect([...h.paid].sort()).toEqual([A.toLowerCase(), REAL.toLowerCase()].sort());
    expect([...h.suspicious].sort()).toEqual([FAKE.toLowerCase(), B.toLowerCase(), C.toLowerCase()].sort());
  });

  it("treats payments executed through a contract wallet as real", () => {
    const owner = B;
    const h = classifyHistory(
      sender,
      [{ hash: "0x10", from: owner, to: sender, value: "0", isError: "0" }], // owner calls execTransaction on the Safe
      [{ hash: "0x10", from: sender, to: REAL, value: "9000000", tokenDecimal: "6" }],
    );
    expect(h.paid.has(REAL.toLowerCase())).toBe(true);
  });

  const facts = (over: Partial<OnchainFacts>): OnchainFacts => ({ recipients: {}, skipped: 0, errors: [], ...over });

  it("stops a poisoned lookalike of an address the sender has paid", () => {
    const onchain = facts({
      history: { available: true, paid: [REAL.toLowerCase()], suspicious: [FAKE.toLowerCase()], truncated: false },
    });
    const r = runPreflight({ list: `${FAKE},100\n${REAL},100\n`, decimals: 18, sender, onchain });
    expect(codes(r, 1)).toEqual(["LOOKALIKE_OF_KNOWN", "POISONING_SIGNATURE"]);
    expect(r.rows[0].findings.every((f) => f.severity === "stop")).toBe(true);
    expect(codes(r, 2)).toContain("PAID_BEFORE");
    expect(r.historyRan).toBe(true);
  });

  it("uses on-chain facts: contracts, unused wallets, supply and balance", () => {
    const onchain = facts({
      recipients: {
        [A.toLowerCase()]: { kind: "contract", nonce: 1, balanceWei: "0" },
        [B.toLowerCase()]: { kind: "eoa", nonce: 0, balanceWei: "0" },
        [C.toLowerCase()]: { kind: "eoa", nonce: 12, balanceWei: "500" },
        [REAL.toLowerCase()]: { kind: "delegated", nonce: 3, balanceWei: "1" },
      },
      token: { address: tokenAddr, symbol: "TRSIV", decimals: 8, totalSupply: (1000n * 10n ** 8n).toString(), senderBalance: (100n * 10n ** 8n).toString() },
    });
    const r = runPreflight({ list: `${A},10\n${B},10\n${C},10\n${REAL},500\n`, decimals: 18, sender, token: tokenAddr, onchain });
    expect(r.decimals).toBe(8);
    expect(r.symbol).toBe("TRSIV");
    expect(codes(r, 1)).toEqual(["CONTRACT_RECIPIENT"]);
    expect(codes(r, 2)).toEqual(["NEVER_USED"]);
    expect(codes(r, 3)).toEqual([]);
    expect(codes(r, 4)).toEqual(["DELEGATED_ACCOUNT"]);
    expect(r.listFindings.map((f) => f.code)).toEqual(["SENDER_SHORT"]);
    const over = runPreflight({ list: `${A},5000\n`, decimals: 18, sender, token: tokenAddr, onchain });
    expect(over.listFindings.map((f) => f.code)).toContain("EXCEEDS_SUPPLY");
  });
});

describe("sample list and fingerprint", () => {
  it("plants one of each mistake", () => {
    const s = buildSample();
    const r = runPreflight({ list: s.list, decimals: 18, trusted: s.trusted, expectedTotal: s.expectedTotal });
    const all = new Set(r.rows.flatMap((row) => row.findings.map((f) => f.code)));
    for (const code of ["LOOKALIKE_OF_KNOWN", "BAD_CHECKSUM", "LOOKS_LIKE_BASE_UNITS", "DUPLICATE", "BURN_ADDRESS", "TRUSTED"]) {
      expect(all, code).toContain(code);
    }
    expect(r.listFindings.map((f) => f.code)).toContain("TOTAL_MISMATCH");
    expect(r.verdict).toBe("stop");
  });

  it("gives the same fingerprint for the same payout and a different one for any change", async () => {
    const one = runPreflight({ list: `${A},100\n${B},200\n`, decimals: 18 });
    const sameDifferentCase = runPreflight({ list: `receiver,amount\n${A.toLowerCase()},100.0\n${B},200\n`, decimals: 18 });
    const changedAmount = runPreflight({ list: `${A},100\n${B},201\n`, decimals: 18 });
    const changedAddress = runPreflight({ list: `${A},100\n${C},200\n`, decimals: 18 });
    const f = (r: typeof one) => fingerprint(r.rows, undefined, 18);
    expect(await f(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(await f(sameDifferentCase)).toBe(await f(one));
    expect(await f(changedAmount)).not.toBe(await f(one));
    expect(await f(changedAddress)).not.toBe(await f(one));
  });
});
