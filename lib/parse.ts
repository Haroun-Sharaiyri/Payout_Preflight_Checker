export interface ParsedLine {
  line: number;
  address: string;
  amount: string;
}

export interface ParsedList {
  rows: ParsedLine[];
  hadHeader: boolean;
  /** Set when the list cannot be read at all. */
  error?: string;
}

const ADDRESS_HEADERS = ["receiver", "recipient", "address", "wallet", "beneficiary", "to", "account"];
const AMOUNT_HEADERS = ["amount", "value", "quantity", "tokens", "allocation", "qty"];

const looksLikeAddress = (s: string) => /^0x[0-9a-fA-F]{6,}/.test(s.trim()) || /\.eth$/i.test(s.trim());

function detectDelimiter(sample: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * Reads a pasted recipient list. Accepts comma, semicolon or tab separated
 * text, with or without a header row, including the Safe "CSV Airdrop" layout
 * (token_type, token_address, receiver, amount, id).
 */
export function parseList(text: string): ParsedList {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const firstContent = lines.find((l) => l.trim() !== "");
  if (!firstContent) return { rows: [], hadHeader: false, error: "The list is empty." };

  const delimiter = detectDelimiter(firstContent);
  const firstFields = splitLine(firstContent, delimiter);
  const hadHeader = !firstFields.some(looksLikeAddress);

  let addressCol = -1;
  let amountCol = -1;

  if (hadHeader) {
    const headers = firstFields.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));
    for (const name of ADDRESS_HEADERS) {
      addressCol = headers.findIndex((h) => h === name || h === `${name}address`);
      if (addressCol !== -1) break;
    }
    for (const name of AMOUNT_HEADERS) {
      amountCol = headers.indexOf(name);
      if (amountCol !== -1) break;
    }
    if (addressCol === -1) {
      return {
        rows: [],
        hadHeader,
        error:
          "No address column found. Name it receiver, recipient or address, or remove the header row and put the address first.",
      };
    }
  } else {
    addressCol = firstFields.findIndex(looksLikeAddress);
    amountCol = firstFields.findIndex((f, i) => i !== addressCol && /^[\d.,\s_]+$/.test(f) && f !== "");
  }

  const rows: ParsedLine[] = [];
  let seenHeader = false;
  lines.forEach((raw, i) => {
    if (raw.trim() === "") return;
    if (hadHeader && !seenHeader) {
      seenHeader = true;
      return;
    }
    const fields = splitLine(raw, delimiter);
    rows.push({
      line: i + 1,
      address: fields[addressCol] ?? "",
      amount: amountCol === -1 ? "" : (fields[amountCol] ?? ""),
    });
  });

  if (rows.length === 0) return { rows, hadHeader, error: "The list has a header but no recipients." };
  return { rows, hadHeader };
}

/** Pulls every 0x address out of free text (used for the trusted list). */
export function extractAddresses(text: string): string[] {
  return text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [];
}
