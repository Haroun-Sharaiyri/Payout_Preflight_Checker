import { getAddress } from "viem";

const make = (hex: string) => getAddress(`0x${hex}`);

/** Flips the case of the first letter so the checksum no longer matches. */
function breakChecksum(address: string): string {
  const i = [...address].findIndex((c, idx) => idx > 1 && /[a-fA-F]/.test(c));
  const c = address[i];
  return address.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + address.slice(i + 1);
}

/**
 * A made-up payout list with one of each mistake planted in it, so the checks
 * can be seen working without real data. None of these are real recipients.
 */
export function buildSample() {
  const treasury = make("7a3f9c2e5b8d41f0a6c3e9b2d5f8a1c4e7b0d3f6");
  const advisor = make("c41d8e2f7a9b3c5d6e0f1a2b3c4d5e6f7a8b9c0d");
  // Same first and last four characters as the advisor, different middle.
  const advisorLookalike = make("c41d5b7e02c94f3a81d6e7b093a52c68f14d9c0d");
  const founder = make("19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
  const investorA = make("5aeda56215b167893e80b4fe645ba6d5bab767de");
  const investorB = make("6330a553fc93768f612722bb8c2ec78ac90b3bbc");
  const investorC = make("b9c5714089478a327f09197987f16f9e5d936e8a");
  const investorD = make("e11ba2b4d45eaed5996cd0823791e0c93114882d");

  const rows = [
    ["receiver", "amount"],
    [treasury, "250000"],
    [advisorLookalike, "40000"],
    [founder, "120000"],
    [investorA, "15000"],
    [investorB, "15000"],
    [breakChecksum(investorC), "15000"],
    [investorD, "15000000000000000000000"],
    [investorA, "15000"],
    ["0x0000000000000000000000000000000000000000", "5000"],
  ];

  return {
    list: rows.map((r) => r.join(",")).join("\n"),
    trusted: [treasury, advisor, founder].join("\n"),
    expectedTotal: "470000",
  };
}
