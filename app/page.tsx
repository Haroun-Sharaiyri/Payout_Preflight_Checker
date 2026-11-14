"use client";

import { useId, useRef, useState } from "react";
import { CHAIN, ONCHAIN_LIMIT } from "@/lib/chain";
import { similarity } from "@/lib/lookalike";
import { formatAmount, runPreflight } from "@/lib/preflight";
import { buildReport, fingerprint } from "@/lib/report";
import { buildSample } from "@/lib/sample";
import type { Finding, OnchainFacts, PreflightInput, PreflightResult, Row, RowStatus } from "@/lib/types";

type Lookup =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; notes: string[]; history: "ran" | "skipped"; historyNote?: string }
  | { state: "failed"; message: string };

interface Run {
  input: PreflightInput;
  result: PreflightResult;
  fingerprint: string;
  at: Date;
}

const VERDICT: Record<RowStatus, { heading: string; body: string }> = {
  stop: { heading: "Do not sign yet", body: "At least one row would send tokens somewhere wrong. Fix every row marked Stop, then run this again." },
  check: { heading: "Review before signing", body: "Nothing is certainly wrong, but some rows need a person to confirm them." },
  clear: { heading: "Nothing found", body: "These checks found no problems. That is not proof the payout is safe: confirm the addresses with their owners." },
};

const LABEL = { stop: "Stop", check: "Check", clear: "Clear", info: "Note" } as const;

function AddressDiff({ mine, other, otherLabel }: { mine: string; other: string; otherLabel: string }) {
  // Only the matching run at each end is "the same"; a stray matching
  // character in the middle is coincidence and would only blur the picture.
  const { prefix, suffix } = similarity(mine, other);
  const render = (address: string) => {
    const hex = address.slice(2);
    return (
      <>
        <span className="diff-same">0x{hex.slice(0, prefix)}</span>
        <span className="diff-differs">{hex.slice(prefix, 40 - suffix)}</span>
        <span className="diff-same">{hex.slice(40 - suffix)}</span>
      </>
    );
  };
  return (
    <dl className="diff">
      <div>
        <dt>This row</dt>
        <dd>{render(mine)}</dd>
      </div>
      <div>
        <dt>{otherLabel}</dt>
        <dd>{render(other)}</dd>
      </div>
    </dl>
  );
}

function FindingItem({ finding, address }: { finding: Finding; address?: string }) {
  const otherLabel = finding.code === "LOOKALIKE_OF_KNOWN" ? "Known address" : "Other row";
  return (
    <li className={`finding finding-${finding.severity}`}>
      <p>
        <strong>{finding.title}.</strong> {finding.detail}
      </p>
      {finding.related && address ? <AddressDiff mine={address} other={finding.related} otherLabel={otherLabel} /> : null}
    </li>
  );
}

function RowItem({ row, decimals, symbol }: { row: Row; decimals: number; symbol?: string }) {
  return (
    <li className={`row row-${row.status}`}>
      <div className="row-head">
        <span className="row-line">Line {row.line}</span>
        <span className="row-address">{row.address ?? (row.rawAddress || "(empty)")}</span>
        <span className="row-amount">
          {row.amount !== undefined ? `${formatAmount(row.amount, decimals)}${symbol ? ` ${symbol}` : ""}` : row.rawAmount}
        </span>
        <span className={`tag tag-${row.status}`}>{LABEL[row.status]}</span>
      </div>
      {row.findings.length > 0 ? (
        <ul className="findings">
          {row.findings.map((f, i) => (
            <FindingItem key={`${f.code}-${i}`} finding={f} address={row.address} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function Page() {
  const [list, setList] = useState("");
  const [sender, setSender] = useState("");
  const [token, setToken] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [expectedTotal, setExpectedTotal] = useState("");
  const [trusted, setTrusted] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [showClear, setShowClear] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const runCounter = useRef(0);
  const ids = { list: useId(), sender: useId(), token: useId(), decimals: useId(), total: useId(), trusted: useId() };

  async function finish(input: PreflightInput, result: PreflightResult) {
    const fp = await fingerprint(result.rows, input.token, result.decimals);
    setRun({ input, result, fingerprint: fp, at: new Date() });
  }

  async function runChecks() {
    const id = ++runCounter.current;
    const dec = Number.parseInt(decimals, 10);
    const input: PreflightInput = {
      list,
      sender,
      token,
      decimals: Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : 18,
      expectedTotal,
      trusted,
    };

    const offline = runPreflight(input);
    await finish(input, offline);
    setCopied(false);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

    const recipients = [...new Set(offline.rows.flatMap((r) => (r.address ? [r.address] : [])))];
    if (recipients.length === 0) {
      setLookup({ state: "failed", message: "There are no valid addresses to look up." });
      return;
    }

    setLookup({ state: "running" });
    try {
      const res = await fetch("/api/onchain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipients, sender: sender.trim(), token: token.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (id !== runCounter.current) return;
      if (!res.ok || !body || body.error) {
        setLookup({ state: "failed", message: body?.error ?? `The server answered with an error (${res.status}).` });
        return;
      }
      const facts = body as OnchainFacts;
      await finish(input, runPreflight({ ...input, onchain: facts }));
      setLookup({
        state: "done",
        notes: facts.errors,
        history: facts.history?.available ? "ran" : "skipped",
        historyNote: facts.history ? facts.history.reason : "Add a sender address to compare recipients with the sender's past payments.",
      });
    } catch {
      if (id !== runCounter.current) return;
      setLookup({ state: "failed", message: "The on-chain lookup could not be reached. Check your connection and run again." });
    }
  }

  function loadSample() {
    const sample = buildSample();
    setList(sample.list);
    setTrusted(sample.trusted);
    setExpectedTotal(sample.expectedTotal);
    setSender("");
    setToken("");
    setDecimals("18");
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setList(await file.text());
    if (fileRef.current) fileRef.current.value = "";
  }

  function downloadReport() {
    if (!run) return;
    const text = buildReport(run.result, { sender: run.input.sender, token: run.input.token, fingerprint: run.fingerprint, generatedAt: run.at });
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `payout-preflight-${run.at.toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyFingerprint() {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.fingerprint);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const result = run?.result;
  const flagged = result?.rows.filter((r) => r.status !== "clear") ?? [];
  const clearRows = result?.rows.filter((r) => r.status === "clear") ?? [];

  return (
    <>
      <header className="band">
        <div className="wrap band-inner">
          <h1>Payout preflight</h1>
          <p className="band-lede">Check a recipient list before anyone signs. Nothing is sent, stored or connected to a wallet.</p>
          <p className="band-network">Reads {CHAIN.name} only</p>
        </div>
      </header>

      <main className="wrap">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void runChecks();
          }}
        >
          <div className="field field-list">
            <label htmlFor={ids.list}>Recipient list</label>
            <p className="hint">One recipient per line: address, amount in whole tokens. A header row is fine, and so is the Safe CSV Airdrop layout.</p>
            <textarea
              id={ids.list}
              className="mono"
              value={list}
              onChange={(e) => setList(e.target.value)}
              rows={13}
              spellCheck={false}
              placeholder={"0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE, 15000\n0x6330A553Fc93768F612722BB8c2eC78aC90B3bbc, 15000"}
              required
            />
            <div className="list-actions">
              <button type="button" className="button-quiet" onClick={() => fileRef.current?.click()}>
                Open a CSV file
              </button>
              <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
              <button type="button" className="button-quiet" onClick={loadSample}>
                Load a sample list with planted mistakes
              </button>
            </div>
          </div>

          <div className="side">
            <div className="field">
              <label htmlFor={ids.sender}>
                Sending address <span className="optional">optional</span>
              </label>
              <input id={ids.sender} className="mono" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
              <p className="hint">The wallet or Safe that will pay. Lets the check compare recipients with its past payments.</p>
            </div>
            <div className="field">
              <label htmlFor={ids.token}>
                Token contract <span className="optional">optional</span>
              </label>
              <input id={ids.token} className="mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
              <p className="hint">Reads the token's decimals, supply and the sender's balance.</p>
            </div>
            <div className="pair">
              <div className="field">
                <label htmlFor={ids.decimals}>Token decimals</label>
                <input id={ids.decimals} inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value)} aria-describedby={`${ids.decimals}-hint`} />
              </div>
              <div className="field">
                <label htmlFor={ids.total}>
                  Expected total <span className="optional">optional</span>
                </label>
                <input id={ids.total} inputMode="decimal" value={expectedTotal} onChange={(e) => setExpectedTotal(e.target.value)} placeholder="470000" />
              </div>
            </div>
            <p className="hint" id={`${ids.decimals}-hint`}>
              When you give a token contract, its own decimals are used instead.
            </p>
            <div className="field">
              <label htmlFor={ids.trusted}>
                Addresses you have verified <span className="optional">optional</span>
              </label>
              <textarea id={ids.trusted} className="mono" value={trusted} onChange={(e) => setTrusted(e.target.value)} rows={3} spellCheck={false} placeholder="One per line" />
              <p className="hint">Any recipient that imitates one of these is stopped.</p>
            </div>
            <button type="submit" className="button-run" disabled={lookup.state === "running"}>
              {lookup.state === "running" ? "Reading Sepolia…" : "Run preflight"}
            </button>
          </div>
        </form>

        {result && run ? (
          <section ref={resultsRef} className="results" aria-live="polite">
            <div className={`verdict verdict-${result.verdict}`}>
              <h2>{VERDICT[result.verdict].heading}</h2>
              <p>{VERDICT[result.verdict].body}</p>
              <dl className="tally">
                <div>
                  <dt>Stop</dt>
                  <dd>{result.counts.stop}</dd>
                </div>
                <div>
                  <dt>Check</dt>
                  <dd>{result.counts.check}</dd>
                </div>
                <div>
                  <dt>Clear</dt>
                  <dd>{result.counts.clear}</dd>
                </div>
                <div className="tally-total">
                  <dt>List total</dt>
                  <dd>
                    {formatAmount(result.total, result.decimals)}
                    {result.symbol ? ` ${result.symbol}` : ""}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="passes">
              <p className="pass pass-ok">List checks ran in your browser.</p>
              {lookup.state === "running" ? <p className="pass">Reading {CHAIN.name}…</p> : null}
              {lookup.state === "failed" ? (
                <p className="pass pass-warn">On-chain checks did not run. {lookup.message} The list checks above still stand.</p>
              ) : null}
              {lookup.state === "done" ? (
                <>
                  <p className="pass pass-ok">
                    On-chain checks ran against {CHAIN.name}
                    {result.rows.length > ONCHAIN_LIMIT ? ` for the first ${ONCHAIN_LIMIT} addresses` : ""}.
                  </p>
                  {lookup.history === "ran" ? (
                    <p className="pass pass-ok">The sender's payment history was read.</p>
                  ) : (
                    <p className="pass pass-warn">Sender history checks did not run. {lookup.historyNote}</p>
                  )}
                  {lookup.notes.map((n) => (
                    <p key={n} className="pass pass-warn">
                      {n}
                    </p>
                  ))}
                </>
              ) : null}
            </div>

            {result.listFindings.length > 0 ? (
              <div className="block">
                <h3>About the whole list</h3>
                <ul className="findings findings-list">
                  {result.listFindings.map((f, i) => (
                    <li key={`${f.code}-${i}`} className={`finding finding-${f.severity}`}>
                      <p>
                        <span className={`tag tag-${f.severity === "info" ? "note" : f.severity}`}>{LABEL[f.severity]}</span> <strong>{f.title}.</strong> {f.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.rows.length > 0 ? (
              <div className="block">
                <h3>{flagged.length > 0 ? `Rows needing attention (${flagged.length})` : "No rows need attention"}</h3>
                <ol className="rows">
                  {flagged.map((row) => (
                    <RowItem key={row.line} row={row} decimals={result.decimals} symbol={result.symbol} />
                  ))}
                </ol>
                {clearRows.length > 0 ? (
                  <>
                    <button type="button" className="button-quiet" aria-expanded={showClear} onClick={() => setShowClear((v) => !v)}>
                      {showClear ? "Hide" : "Show"} the {clearRows.length} clear {clearRows.length === 1 ? "row" : "rows"}
                    </button>
                    {showClear ? (
                      <ol className="rows rows-clear">
                        {clearRows.map((row) => (
                          <RowItem key={row.line} row={row} decimals={result.decimals} symbol={result.symbol} />
                        ))}
                      </ol>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="block handoff">
              <h3>Hand this to the signers</h3>
              <p>
                The fingerprint is computed from the network, the token and every address and amount in order. A signer who runs the same list here must get the same
                fingerprint. If it differs, they were sent a different list.
              </p>
              <p className="fingerprint mono">{run.fingerprint}</p>
              <div className="handoff-actions">
                <button type="button" className="button-solid" onClick={downloadReport} disabled={lookup.state === "running"}>
                  Download report
                </button>
                <button type="button" className="button-quiet" onClick={() => void copyFingerprint()}>
                  {copied ? "Fingerprint copied" : "Copy fingerprint"}
                </button>
                <button type="button" className="button-quiet" onClick={() => window.print()}>
                  Print
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="explain">
            <h2>What gets checked</h2>
            <div className="explain-grid">
              <div>
                <h3>The addresses</h3>
                <p>
                  Failed checksums, wrong lengths, burn addresses, the token's own contract, duplicates, and addresses that share their first and last characters with
                  one you trust or with another row.
                </p>
              </div>
              <div>
                <h3>The amounts</h3>
                <p>Base units pasted as whole tokens, rows a hundred times the rest, more decimals than the token has, and a list that misses your expected total.</p>
              </div>
              <div>
                <h3>The chain</h3>
                <p>
                  Whether each recipient is a wallet or a contract, whether it has ever been used, and whether the sender's only history with it is a zero-value or dust
                  transfer.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="wrap foot">
        <p>
          This tool cannot tell you who controls an address, and it reads {CHAIN.name} only. A clear result means these checks found nothing. It does not mean the payout
          is safe.
        </p>
      </footer>
    </>
  );
}
