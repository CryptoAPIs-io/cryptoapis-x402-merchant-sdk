# @cryptoapis/x402-merchant-sdk

Monetize any API per-request with the **x402** protocol, settled by the **CryptoAPIs facilitator**.
Return an HTTP `402 Payment Required` with the price, and the SDK verifies + settles the buyer's
on-chain payment for you. Non-custodial — the SDK never holds keys or signs; the buyer signs locally and
the facilitator's gas wallet settles.

## Install

```bash
npm install @cryptoapis/x402-merchant-sdk
```

## Express — monetize a route in 3 lines

```js
import express from 'express';
import { paymentMiddleware } from '@cryptoapis/x402-merchant-sdk/express';

const app = express();
const pay = paymentMiddleware({
    apiKey: process.env.CRYPTOAPIS_API_KEY, // your CryptoAPIs key (X402_FACILITATOR feature)
    payTo: '0xYourReceivingAddress',
});

// Base USDC, $0.01 (10000 = 0.01 * 10^6). Buyer with no valid payment gets a 402 + these terms.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
app.get('/premium',
    pay({ network: 'eip155:8453', asset: USDC_BASE, amount: '10000' }),
    (req, res) => {
        // Reached only after the payment is verified AND settled on-chain.
        // req.x402 = { payer, settlement: { transaction, network, ... } }
        res.json({ data: 'the paid resource', paidBy: req.x402.payer });
    });
```

A buyer's agent hits `/premium`, gets `402` + the `accepts` list, has its wallet sign the payment
locally (e.g. via `@cryptoapis-io/mcp-signer`), and retries with the `X-PAYMENT` header. The middleware
verifies + settles and, on success, sets `X-PAYMENT-RESPONSE` (the settlement receipt) and calls `next()`.

## Multiple assets / networks

Pass an array to offer the buyer a choice (the 402 `accepts` list):

```js
app.get('/premium', pay([
    { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
    { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC_SOL, amount: '10000',
      extra: { feePayer: '<facilitator feePayer>', decimals: 6, tokenProgram: 'spl-token' } },
]), handler);
```

## Framework-agnostic core

Not on Express? Use the core directly:

```js
import { createFacilitatorClient, runPaymentGate, buildPaymentRequirements } from '@cryptoapis/x402-merchant-sdk';

const facilitator = createFacilitatorClient({ apiKey });
const accepts = [buildPaymentRequirements({ network, asset, amount, payTo })];

const result = await runPaymentGate({
    paymentHeader: req.headers['x-payment'],
    accepts,
    facilitator,
});
// result.outcome: 'payment-required' | 'paid' | 'invalid'
```

## How it works

1. **No `X-PAYMENT`** → `payment-required`: respond `402` with `{ x402Version, accepts: [PaymentRequirements] }`.
2. Buyer signs locally and retries with the base64 `X-PAYMENT` header (the x402 `PaymentPayload`).
3. SDK calls the facilitator **`/verify`** (does it authorize exactly this payment? AML + travel-rule +
   simulate) then **`/settle`** (facilitator signs the settle tx + broadcasts).
4. **Paid** → `next()` with `req.x402` + the `X-PAYMENT-RESPONSE` receipt header. **Invalid** → `402`.

## Config

- `apiKey` (required) — your CryptoAPIs API key with the `X402_FACILITATOR` feature.
- `payTo` — default receiving address (override per-route with `pay({ ..., payTo })`).
- `baseUrl` — facilitator base URL (default `https://ai.cryptoapis.io/x402/merchant`; set for QA/local).
- `settle` — `true` (default) verifies AND settles; `false` verifies only (advisory, rarely used).

Amounts are in the asset's **atomic units** (USDC 6-decimals: `"10000"` = $0.01). Networks are CAIP-2.
