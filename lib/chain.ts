/**
 * The one network this build reads. Testnet only, on purpose.
 * Moving to another network means changing this object and the viem chain
 * imported in app/api/onchain/route.ts.
 */
export const CHAIN = {
  id: 11155111,
  name: "Sepolia testnet",
  explorer: "https://sepolia.etherscan.io",
} as const;

/** Addresses looked up on-chain per run. Keeps one request inside serverless time limits. */
export const ONCHAIN_LIMIT = 200;
