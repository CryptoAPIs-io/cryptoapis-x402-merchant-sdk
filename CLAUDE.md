# CLAUDE.md — @cryptoapis-io/x402-merchant-sdk

The **merchant-facing** x402 SDK (Node 18+, ESM, zero runtime deps). Lets any API monetize per-request
with x402, settled by the CryptoAPIs facilitator. One of the x402 client surfaces (the others are the
buyer signing path via `@cryptoapis-io/mcp-signer` + the buyer service `/authorize`). **Non-custodial:
holds no keys, signs nothing** — it only states a price and relays the buyer's signed payload to the
facilitator.

## The flow it implements
1. Request with no valid `X-PAYMENT` → respond **HTTP 402** with `{ x402Version:2, accepts:
   [PaymentRequirements] }` (the buyer learns what to pay).
2. Buyer signs locally, retries with the base64 `X-PAYMENT` header (an x402 `PaymentPayload`).
3. SDK calls the facilitator **`/verify`** then **`/settle`** (both `{ paymentRequirements,
   paymentPayload }`, `x-api-key` auth). On success → serve the resource + set `X-PAYMENT-RESPONSE`.

## Modules (`src/`)
- `facilitatorClient.js` — `createFacilitatorClient({apiKey, baseUrl, fetchImpl})` → `verify`/`settle`/
  `supported`. Uses global `fetch` (injectable for tests). A **non-2xx throws** (transport/auth error);
  a protocol failure is HTTP 200 with `isValid/success:false` — the caller inspects the body.
- `paymentRequirements.js` — `buildPaymentRequirements` (`{scheme, network, amount, asset, payTo,
   maxTimeoutSeconds, extra}`) + `build402Body` (`{x402Version:2, accepts, error?}`). Amounts are ATOMIC
   units; networks are CAIP-2.
- `paymentGate.js` — **the framework-agnostic core.** `runPaymentGate({paymentHeader, accepts,
   facilitator, settle})` → `{outcome: 'payment-required'|'paid'|'invalid', status, body?, headers?,
   payer?, settlement?}`. Decodes the base64 `X-PAYMENT`, matches it to an `accepts` entry by
   `(scheme, network)`, verifies, then settles. Verify-fail short-circuits (never settles).
- `express.js` (`/express` export) — `paymentMiddleware({apiKey, payTo, baseUrl, settle, facilitator})`
   → `pay(priceSpec | priceSpec[])` → Express middleware. On paid: `req.x402 = {payer, settlement}` +
   `next()`. On 402: sends the body. On a facilitator transport error: `next(err)` (502-class, NOT 402 —
   the buyer did nothing wrong).
- `index.js` — barrel (core only; the Express adapter is the `/express` subpath export).

## Non-negotiable
- **Non-custodial.** No keys, no signing, ever. The buyer signs; the facilitator's gas wallet settles.
- **402 vs 502.** A rejected/absent payment is the buyer's concern → `402`. A facilitator being
  down/unauthorized is the merchant's dependency failing → surface as an error (`next(err)`), never a 402.
- **Zero runtime deps.** Uses global `fetch` + `Buffer` only, so it drops into any Node 18+ service.

## Facilitator contract (what this calls)
`ai.cryptoapis.io/x402/merchant/{verify,settle,supported}`, `x-api-key` = the merchant's CryptoAPIs key
with the `X402_FACILITATOR` feature. `/verify` → `{isValid, payer, invalidReason?}`; `/settle` →
`{success, payer, transaction, network, errorReason?}`. See `cryptoapis-x402-facilitator` + KB
`functional/x402-facilitator`.

## Commands
```bash
npm install
npm test          # node --test (paymentGate + facilitatorClient + express, mocked facilitator)
npm run lint      # eslint (@common config; tests relax jsdoc/object-shorthand)
```
Tests live under `tests/`, never colocated.

## Status
Code-only (built + unit-tested, 25 tests; not published). v1: EVM/SVM/all-families via the facilitator's
family dispatch — the SDK is family-agnostic (it just relays paymentRequirements+payload). Later:
`x402-next` / `x402-hono` adapters (same core, new thin wrappers).
