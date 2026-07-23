# @cryptoapis-io/x402-merchant-sdk

**Monetize any API per request** with the [x402](https://x402.org) protocol — settled on-chain by the
CryptoAPIs facilitator. Return a `402 Payment Required`, and the SDK verifies and settles the buyer's
stablecoin payment for you. Add it to a route in three lines.

- 🔒 **Non-custodial** — the SDK holds no keys and never signs. The buyer signs; the facilitator settles.
- 🪶 **Zero runtime dependencies** — pure `fetch` + `Buffer`. Node 18+ / edge / any modern runtime.
- 🧩 **Express, Hono, Next.js** adapters + a framework-agnostic core.
- 🌐 **Any x402 chain** — you just state a price; the facilitator handles EVM, Solana, and more.

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

## Offer multiple assets / networks

Pass an array — the buyer picks one (it becomes the `accepts` list in the 402):

```js
app.get('/premium', pay([
  { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
  { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC_SOL, amount: '10000',
    extra: { feePayer: '<facilitator feePayer>', decimals: 6, tokenProgram: 'spl-token' } },
]), handler);
```

---

## How it works

1. **No `X-PAYMENT`** → respond `402` with `{ x402Version, accepts: [PaymentRequirements] }`.
2. The buyer signs a payment locally and retries with a base64 `X-PAYMENT` header.
3. The SDK calls the facilitator **`/verify`** (does this authorize exactly the required payment? AML +
   travel-rule + on-chain simulate) then **`/settle`** (the facilitator signs the settle tx + broadcasts).
4. **Paid** → your handler runs, with `req.x402` + an `X-PAYMENT-RESPONSE` receipt. **Invalid** → `402`.

A facilitator/transport error is surfaced as an error (`next(err)` / a thrown error), **not** a `402` — a
failing dependency is the merchant's problem, not the buyer's.

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
