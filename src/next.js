/**
 * Next.js (App Router) route wrapper for x402 — monetize a route handler:
 *
 *   import { withX402 } from '@cryptoapis/x402-merchant-sdk/next';
 *   const pay = withX402({ apiKey: process.env.CRYPTOAPIS_API_KEY, payTo: '0x…' });
 *   export const GET = pay(
 *       { network: 'eip155:8453', asset: USDC, amount: '10000' },
 *       async (req, x402) => Response.json({ data: 'paid', paidBy: x402.payer }),
 *   );
 *
 * Works with Web `Request`/`Response` (App Router / edge). No valid `X-PAYMENT` →
 * returns a 402 `Response` with the PaymentRequirements. On a settled payment it calls
 * your handler with `(req, x402)` and adds the `X-PAYMENT-RESPONSE` header to whatever
 * `Response` you return. Same core (`runPaymentGate`) as the Express/Hono adapters.
 */

import { createFacilitatorClient } from './facilitatorClient.js';
import { buildPaymentRequirements } from './paymentRequirements.js';
import {
    runPaymentGate, PAYMENT_HEADER
} from './paymentGate.js';

/**
 * Build a Next route-wrapper factory bound to a merchant + facilitator.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the merchant's CryptoAPIs API key (X402_FACILITATOR feature)
 * @param {string} [params.payTo] default receiving address (overridable per-route)
 * @param {string} [params.baseUrl] facilitator base URL override
 * @param {boolean} [params.settle] settle on-chain (default true)
 * @param {Object} [params.facilitator] a pre-built facilitatorClient (injectable for tests)
 * @return {Function} `pay(priceSpec | priceSpec[], handler)` → a Next route handler
 */
function withX402({ apiKey, payTo: defaultPayTo, baseUrl, settle = true, facilitator } = {}) {
    const client = facilitator ?? createFacilitatorClient({
        apiKey: apiKey,
        baseUrl: baseUrl
    });

    /**
     * Wrap a route handler behind an x402 paywall.
     *
     * @param {(Object|Array<Object>)} price a price spec or a list (the 402 `accepts`)
     * @param {Function} handler `(req, x402) => Response|Promise<Response>` — called only when paid
     * @return {Function} a Next App-Router route handler `(req) => Promise<Response>`
     */
    return function pay(price, handler) {
        const specs = Array.isArray(price) ? price : [price];
        const accepts = specs.map((s) => buildPaymentRequirements({
            network: s.network,
            asset: s.asset,
            amount: s.amount,
            payTo: s.payTo ?? defaultPayTo,
            maxTimeoutSeconds: s.maxTimeoutSeconds,
            extra: s.extra,
            scheme: s.scheme,
        }));

        return async function x402Route(req, ctx) {
            const result = await runPaymentGate({
                paymentHeader: req.headers.get(PAYMENT_HEADER),
                accepts: accepts,
                facilitator: client,
                settle: settle,
            });
            if (result.outcome !== 'paid') {
                return Response.json(result.body, { status: result.status });
            }
            const x402 = {
                payer: result.payer,
                settlement: result.settlement
            };
            const res = await handler(req, x402, ctx);
            // Add the settlement receipt header to the handler's response.
            if (result.headers && res && typeof res.headers?.set === 'function') {
                for (const [k, v] of Object.entries(result.headers)) {
                    res.headers.set(k, v);
                }
            }
            return res;
        };
    };
}

export { withX402 };
