# Charge an AI agent for an MCP tool

A complete, runnable MCP server with **one paid tool**. An agent calls it, gets a price, pays it,
and only then receives the result.

This is the **merchant half** of the x402 MCP transport
([`specs/transports-v2/mcp.md`](https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md)).
The buyer half — an agent that pays tools like this one — is
[`@cryptoapis-io/x402-buyer-sdk/mcp`](https://www.npmjs.com/package/@cryptoapis-io/x402-buyer-sdk).

## Run it

```bash
npm install
CRYPTOAPIS_API_KEY=… X402_PAY_TO=0xYourReceivingAddress npm start
```

- `CRYPTOAPIS_API_KEY` — a CryptoAPIs key with the **`X402_FACILITATOR`** feature enabled.
- `X402_PAY_TO` — where the money lands. On Base that is an ordinary EVM address.

The server speaks **stdio**, so point any MCP client at `node server.js`. In Claude Code:

```bash
claude mcp add paid-analysis -- node /absolute/path/to/server.js
```

Both env vars are checked at boot. A server that starts and only fails when someone tries to pay
looks like a payment bug to every agent that hits it.

## What happens on the wire

| Step | What the agent sees |
|---|---|
| 1. Unpaid call | A tool result with `isError: true`, carrying `PaymentRequired` in **both** `structuredContent` and `content[0].text` |
| 2. Agent pays | Signs locally, retries with the `PaymentPayload` in `_meta["x402/payment"]` — a raw object, **no base64** (MCP carries JSON natively) |
| 3. Paid call | Your handler runs, and the result carries the receipt in `_meta["x402/payment-response"]` |

Your handler **only ever runs after settlement**. An unpaid or rejected call never reaches it, so
you never do the work for free — the spec's "withhold the tool's output when payment fails" rule
holds by construction rather than by remembering to check.

## Changing the price

`amount` is in **atomic units**. USDC has 6 decimals, so `'10000'` is $0.01. Being wrong here by a
factor of 10^6 is the easiest mistake to make in the whole file.

To accept several assets or networks, pass an array — the agent picks one:

```js
pay('financial_analysis', [
  { network: 'eip155:8453', asset: USDC_BASE, amount: '10000' },
  { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC_SOL, amount: '10000',
    extra: { feePayer: '<facilitator feePayer>', decimals: 6, tokenProgram: 'spl-token' } },
], handler)
```

The facilitator's live `feePayer` and the networks/assets it will actually settle come from
`GET https://ai.cryptoapis.io/x402/merchant/supported` (public, no API key). Offer only what that
endpoint lists — anything else is advertised and then rejected at `/verify`.

## Testing without moving money

Pass `settle: false` to `paymentTool({...})` to verify a payment without settling it on-chain. Useful
while wiring things up, but it is advisory only: the buyer proved they *could* pay, not that they
*did*. Never ship it.

For an end-to-end test with real (worthless) money, use **Base Sepolia** — `eip155:84532` with the
testnet USDC — rather than mainnet.

## Notes

- The tool `description` states the price. An agent that only discovers the cost by being refused has
  already wasted a round-trip, and may just pick a competitor's tool instead.
- `resource.url` defaults to the spec's `mcp://tool/<name>`. Override it via `resource` on the price
  spec if you want to attach a description or mimeType.
- This example depends on `@modelcontextprotocol/sdk`; the SDK itself has **zero runtime
  dependencies** and never pulls it in.
