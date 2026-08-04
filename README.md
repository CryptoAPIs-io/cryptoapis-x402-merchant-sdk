# @cryptoapis-io/x402-merchant-sdk

**Monetize any API per request** with the [x402](https://x402.org) protocol — settled on-chain by the
CryptoAPIs facilitator. Return a `402 Payment Required`, and the SDK verifies and settles the buyer's
stablecoin payment for you. Add it to a route in three lines.

- 🔒 **Non-custodial** — the SDK holds no keys and never signs. The buyer signs; the facilitator settles.
- 🪶 **Zero runtime dependencies** — pure `fetch` + `Buffer`. Node 18+ / edge / any modern runtime.
- 🧩 **Express, Hono, Next.js** adapters + a framework-agnostic core.
- 🌐 **Any x402 chain** — you just state a price; the facilitator handles EVM, Solana, and more.
- 🪙 **Solana token accounts are handled for you** — point `payTo` at any wallet, even one that has
  never held the token and holds no SOL. The facilitator creates the ATA and pays the rent.
  [Details](#solana-token-accounts-are-handled-for-you)

```bash
npm install @cryptoapis-io/x402-merchant-sdk
```

---

## Quick start — Express, 3 lines

```js
import express from 'express';
import { paymentMiddleware } from '@cryptoapis-io/x402-merchant-sdk/express';

const app = express();
const pay = paymentMiddleware({
  apiKey: process.env.CRYPTOAPIS_API_KEY,   // CryptoAPIs key with the X402_FACILITATOR feature
  payTo:  '0xYourReceivingAddress',
});

// Base USDC, $0.01 (10000 = 0.01 × 10^6).
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

app.get('/premium',
  pay({ network: 'eip155:8453', asset: USDC_BASE, amount: '10000' }),
  (req, res) => {
    // Reached only after payment is verified AND settled on-chain.
    res.json({ data: 'the paid resource', paidBy: req.x402.payer });
  });
```

A caller with no payment gets `402` + the price. Their agent/wallet pays (see the
[buyer SDK](https://www.npmjs.com/package/@cryptoapis-io/x402-buyer-sdk)) and retries with an `X-PAYMENT`
header; the middleware verifies + settles, exposes `req.x402 = { payer, settlement }`, sets an
`X-PAYMENT-RESPONSE` receipt, and calls `next()`.

---

## Hono

```js
import { paymentMiddleware } from '@cryptoapis-io/x402-merchant-sdk/hono';

const pay = paymentMiddleware({ apiKey, payTo: '0x…' });
app.get('/premium',
  pay({ network: 'eip155:8453', asset: USDC_BASE, amount: '10000' }),
  (c) => c.json({ paidBy: c.get('x402').payer }));
```

## Next.js (App Router)

```js
import { withX402 } from '@cryptoapis-io/x402-merchant-sdk/next';

const pay = withX402({ apiKey, payTo: '0x…' });

export const GET = pay(
  { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
  async (req, x402) => Response.json({ data: 'paid', paidBy: x402.payer }),
);
```

## Any framework — the core

```js
import { createFacilitatorClient, runPaymentGate, buildPaymentRequirements } from '@cryptoapis-io/x402-merchant-sdk';

const facilitator = createFacilitatorClient({ apiKey });
const accepts     = [buildPaymentRequirements({ network, asset, amount, payTo })];

const result = await runPaymentGate({
  paymentHeader: req.headers['x-payment'],   // however your framework exposes headers
  accepts,
  facilitator,
});
// result.outcome: 'payment-required' | 'paid' | 'invalid'
```

### Corporate proxies / custom CA

Behind a TLS-intercepting corporate proxy, Node's global `fetch` fails with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. `createFacilitatorClient` accepts a **`fetchImpl`** — pass a `fetch`
bound to your CA / proxy agent (e.g. `undici`) so `/verify` + `/settle` route through it; the
`paymentMiddleware` / `runPaymentGate` then take that client via `facilitator`:

```js
import { fetch as undiciFetch, Agent } from 'undici';
import { readFileSync } from 'node:fs';

const agent = new Agent({ connect: { ca: readFileSync('/etc/corp/ca.pem') } });
const facilitator = createFacilitatorClient({
  apiKey,
  fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }),
});
// pass `facilitator` to paymentMiddleware({ facilitator }) / runPaymentGate({ facilitator })
```

Inject the CA — never disable TLS verification globally.

---

## MCP — charge for an AI-agent tool

Agents call **MCP tools**, not HTTP endpoints. The `/mcp` adapter monetizes a tool with the same core:

```js
import { paymentTool } from '@cryptoapis-io/x402-merchant-sdk/mcp';

const pay = paymentTool({
  apiKey: process.env.CRYPTOAPIS_API_KEY,
  payTo:  '0xYourReceivingAddress',
});

// Base USDC, $0.01 — wrap the handler you already have.
server.registerTool('financial_analysis', schema, pay(
  'financial_analysis',
  { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
  async (args) => ({ content: [{ type: 'text', text: analyse(args.ticker) }] })
));
```

Unpaid calls get a tool result with `isError: true` carrying the `PaymentRequired` in **both**
`structuredContent` and `content[0].text` (the transport spec requires both). The agent pays, retries with
the payment in `_meta["x402/payment"]`, and the paid result carries the receipt in
`_meta["x402/payment-response"]`.

Your handler **only ever runs once payment has settled** — an unpaid or failed call never reaches it, so a
merchant never does the work for free.

**Runnable example:** [`examples/mcp-paid-tool/`](examples/mcp-paid-tool/) — a complete MCP server with one
paid tool. `npm install && npm start`. The buyer half (an agent that pays tools like it) is
[`@cryptoapis-io/x402-buyer-sdk/mcp`](https://www.npmjs.com/package/@cryptoapis-io/x402-buyer-sdk).

---

## A2A — charge another agent

The third x402 transport. A2A is task-based, so payment is signalled by moving the task to
`input-required` rather than by a status code:

```js
import { paymentSkill, agentCardExtension } from '@cryptoapis-io/x402-merchant-sdk/a2a';

const pay = paymentSkill({ apiKey: process.env.CRYPTOAPIS_API_KEY, payTo: '0xYourAddress' });

const generateImage = pay(
  { url: 'https://api.example.com/generate-image', mimeType: 'image/png' },
  { network: 'eip155:8453', asset: USDC_BASE, amount: '48240000' },
  async (params) => ({ artifacts: [await render(params)] }),
);
```

Declare the extension in your AgentCard so clients know you take payment:

```js
{ capabilities: { extensions: [agentCardExtension()] } }
```

Unpaid calls return a task in `input-required` carrying `PaymentRequired` under the metadata key
`x402.payment.required`. The client pays in a new message under `x402.payment.payload`, correlated by
`taskId`; the settled task completes with receipts in `x402.payment.receipts`.

Note the metadata keys are **literal dotted strings** — `metadata["x402.payment.required"]`, not a
nested `{x402:{payment:{…}}}` object. As with the other transports, your handler runs only after
settlement.

---

## Offer multiple assets / networks

Pass an array — the buyer picks one (it becomes the `accepts` list in the 402):

```js
app.get('/premium', pay([
  { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
  { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC_SOL, amount: '10000',
    extra: { feePayer: '<facilitator feePayer>', decimals: 6, tokenProgram: 'spl-token' } },
]), handler);
```

### Solana token accounts are handled for you

**CryptoAPIs takes care of Solana associated token accounts. You never create one.**

On Solana a wallet cannot receive an SPL token until an **associated token account (ATA)**
exists for that mint — normally the recipient's problem to solve, and to pay rent for,
before anyone can pay them. Every other x402 facilitator makes this your job.

Point `payTo` at a plain Solana wallet address, even a brand-new one that has never held
the token and holds no SOL. When a payment arrives and the account is missing, the
CryptoAPIs facilitator creates it as part of the settlement transaction and **pays the
rent** — the same way it pays the transaction fee. No `spl-token create-account`, no
pre-funding, no SOL balance on your receiving address, no setup step at all.

```js
// A never-used Solana address works as payTo — nothing to set up first.
{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC_SOL, amount: '10000',
  extra: { feePayer: '<facilitator feePayer>', decimals: 6, tokenProgram: 'spl-token' } }
```

The account is created idempotently, so a merchant who already has an ATA is unaffected
and pays nothing extra.

> One detail worth knowing: the facilitator funds the account creation, but the instruction
> travels in the buyer's transaction. Buyers paying through CryptoAPIs get it automatically.
> A buyer that hand-builds its own Solana transaction needs to include it — the facilitator
> accepts and pays for it either way, but cannot add an instruction to an already-signed
> transaction.

---

## How it works

1. **No `X-PAYMENT`** → respond `402` with `{ x402Version, accepts: [PaymentRequirements] }`.
2. The buyer signs a payment locally and retries with a base64 `X-PAYMENT` header.
3. The SDK calls the facilitator **`/verify`** (does this authorize exactly the required payment? AML +
   travel-rule + on-chain simulate) then **`/settle`** (the facilitator signs the settle tx + broadcasts).
4. **Paid** → your handler runs, with `req.x402` + an `X-PAYMENT-RESPONSE` receipt. **Invalid** → `402`.

A facilitator/transport error is surfaced as an error (`next(err)` / a thrown error), **not** a `402` — a
failing dependency is the merchant's problem, not the buyer's.

### Failure reasons are x402 standard codes

`invalidReason` (verify) and `errorReason` (settle) are the codes from
[x402 v2 §9](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), so you can branch
on them the same way you would against any x402 facilitator — `invalid_exact_evm_payload_signature`,
`invalid_exact_evm_payload_authorization_valid_before`, `insufficient_funds`, `invalid_network`,
`invalid_transaction_state`, and so on.

Where CryptoAPIs refuses for a reason the spec does not model — an AML screen, the travel-rule cap, an
asset that is not enabled — you still get a **standard** code plus an `invalidDetail` / `errorDetail`
naming the real cause:

```json
{ "isValid": false, "invalidReason": "invalid_payment_requirements", "invalidDetail": "aml_rejected" }
```

Branch on the standard code; log the detail.

---

## Discovery — before you integrate

Both endpoints are **public**: no API key, so you can check we serve your chain before signing up.

```js
import { createFacilitatorClient } from '@cryptoapis-io/x402-merchant-sdk';

const fac = createFacilitatorClient({ apiKey: process.env.CRYPTOAPIS_API_KEY });

// What can this facilitator settle?
const { kinds, extensions, signers } = await fac.supported();
// kinds      → [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, …]
// extensions → ['payment-identifier']
// signers    → { 'eip155:*': ['0x…'], 'solana:*': ['9BD…'] }   (CAIP-2 namespace patterns)

// What is already for sale behind it? (the x402 "Bazaar", spec §8)
const { items, pagination } = await fac.discovery({ type: 'http', limit: 20 });
```

`signers` is keyed by **CAIP-2 namespace pattern** (`eip155:*`), not by concrete network — one signer
pool serves every chain in its namespace. A namespace listed with an empty array is served
*broadcast-only*: the buyer signs and pays their own fee, and the facilitator holds no key for it.

---

## Configuration

| Option | Required | Description |
|---|---|---|
| `apiKey` | ✓ | CryptoAPIs API key with the `X402_FACILITATOR` feature |
| `payTo` | | default receiving address (override per route: `pay({ …, payTo })`) |
| `baseUrl` | | facilitator base URL (default `https://ai.cryptoapis.io/x402/merchant`) |
| `settle` | | `true` (default) verifies **and** settles; `false` verifies only (advisory) |

Price fields: `network` ([CAIP-2](https://chainagnostic.org/CAIPs/caip-2)), `asset` (token contract/mint or
`native`), `amount` (**atomic units** — USDC 6-decimals: `"10000"` = $0.01), optional `extra` (family
specifics, e.g. Solana `feePayer`).

## Related

- **[`@cryptoapis-io/x402-buyer-sdk`](https://www.npmjs.com/package/@cryptoapis-io/x402-buyer-sdk)** — the buyer side: pay for x402 endpoints (apps + AI agents).
- **[`@cryptoapis-io/mcp-x402-pay`](https://www.npmjs.com/package/@cryptoapis-io/mcp-x402-pay)** — MCP server so coding agents can pay.
- [CryptoAPIs docs](https://developers.cryptoapis.io) · [x402 protocol](https://x402.org)

## License

MIT © Crypto APIs, Inc.
