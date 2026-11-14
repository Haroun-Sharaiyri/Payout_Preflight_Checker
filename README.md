# Payout preflight

A read-only check for a token payout list, run before anyone signs. Paste the
recipient list and it flags the rows that would send tokens somewhere wrong.

Nothing is sent, nothing is stored, and no wallet is connected.

**This build reads Sepolia testnet only.**

## What it checks

| Area | Checks |
| --- | --- |
| Addresses | Failed checksum, wrong length, ENS names, hidden characters, zero and burn addresses, the token's own contract, the sender, duplicates |
| Lookalikes | A recipient that shares its first and last characters with an address you trust, an address the sender has paid before, or another row |
| Amounts | Base units pasted as whole tokens, rows 100x the typical row, too many decimals, a list that misses the expected total, more than the token's supply, more than the sender holds |
| On-chain | Contract or wallet, never-used addresses, and recipients whose only history with the sender is a zero-value, dust or spoofed transfer (the address-poisoning signature) |

Each row comes back as **Stop**, **Check** or **Clear**. The report includes a
SHA-256 fingerprint of the network, token and every address and amount, so a
signer can confirm they are looking at the same list.

## What it does not do

- It cannot tell who controls an address.
- It checks the list, not the transaction a signer is shown.
- A clear result means these checks found nothing. It is not proof of safety.

## Deploy on Vercel

1. Import this repository in Vercel. The defaults work (framework: Next.js).
2. In **Settings > Environment Variables**, add:
   - `ETHERSCAN_API_KEY`: a free key from <https://etherscan.io/apidashboard>.
     Without it the sender-history checks are skipped and the page says so.
   - `SEPOLIA_RPC_URL` (optional): a private Sepolia RPC URL. Public endpoints
     are used when it is empty, and they are sometimes rate limited.
3. Redeploy after adding variables.

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in ETHERSCAN_API_KEY
npm run dev                  # http://localhost:3000
npm test                     # check-engine tests
```

## List format

One recipient per line, address then amount in whole tokens. A header row is
optional. Comma, semicolon and tab separated files all work, and so does the
Safe CSV Airdrop layout (`token_type,token_address,receiver,amount,id`).

```
receiver,amount
0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE,15000
0x6330A553Fc93768F612722BB8c2eC78aC90B3bbc,15000
```

## Limits

- On-chain lookups cover the first 200 unique addresses per run. Offline checks
  cover the whole list.
- Sender history reads the most recent 5,000 transactions and 5,000 token
  transfers.
- The `/api/onchain` route is public and unauthenticated. It only reads public
  chain data, but anyone who finds it can spend your Etherscan quota. Add rate
  limiting before pointing real traffic at it.

## Layout

- `lib/` holds the check engine. It is pure TypeScript with no network calls.
- `app/api/onchain/route.ts` is the only server code: it reads Sepolia and
  Etherscan and returns facts for the engine.
- `app/page.tsx` is the page.
- `tests/` covers the engine, including a lookalike swap of the kind that
  diverted a real airdrop allocation in 2026.

Moving to another network means changing `lib/chain.ts` and the chain import in
the route.
