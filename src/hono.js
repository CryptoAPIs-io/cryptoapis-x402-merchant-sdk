/**
 * Hono middleware for x402 — monetize a route in ~3 lines:
 *
 *   import { paymentMiddleware } from '@cryptoapis-io/x402-merchant-sdk/hono';
 *   const pay = paymentMiddleware({ apiKey: process.env.CRYPTOAPIS_API_KEY, payTo: '0x…' });
 *   app.get('/premium', pay({ network: 'eip155:8453', asset: USDC, amount: '10000' }), (c) => c.json({ ok: true }));
 *
 * No valid `X-PAYMENT` → responds 402 with the PaymentRequirements. On a settled
 * payment it sets `c.set('x402', {payer, settlement})`, the `X-PAYMENT-RESPONSE`
 * header, and calls `await next()`. Same core (`runPaymentGate`) as the Express adapter.
 */

import { createFacilitatorClient } from './facilitatorClient.js';
import { buildPaymentRequirements } from './paymentRequirements.js';
import {
    runPaymentGate, PAYMENT_HEADER
} from './paymentGate.js';

/**
 * Build a Hono payment-middleware factory bound to a merchant + facilitator.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the merchant's CryptoAPIs API key (X402_FACILITATOR feature)
 * @param {string} [params.payTo] default receiving address (overridable per-route)
 * @param {string} [params.baseUrl] facilitator base URL override
 * @param {boolean} [params.settle] settle on-chain (default true)
 * @param {Object} [params.facilitator] a pre-built facilitatorClient (injectable for tests)
 * @return {Function} `pay(priceSpec | priceSpec[])` → a Hono middleware
 */
function paymentMiddleware({ apiKey, payTo: defaultPayTo, baseUrl, settle = true, facilitator } = {}) {
    const client = facilitator ?? createFacilitatorClient({
        apiKey: apiKey,
        baseUrl: baseUrl
    });

    /**
     * Create the middleware for a priced route.
     *
     * @param {(Object|Array<Object>)} price a price spec or a list (the 402 `accepts`)
     * @return {Function} the Hono middleware `(c, next)`
     */
    return function pay(price) {
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

        return async function x402Middleware(c, next) {
            const result = await runPaymentGate({
                paymentHeader: c.req.header(PAYMENT_HEADER),
                accepts: accepts,
                facilitator: client,
                settle: settle,
            });
            if (result.outcome === 'paid') {
                if (result.headers) {
                    for (const [k, v] of Object.entries(result.headers)) {
                        c.header(k, v);
                    }
                }
                c.set('x402', {
                    payer: result.payer,
                    settlement: result.settlement
                });
                await next();
                return undefined;
            }
            // payment-required or invalid → 402 with the requirements body.
            return c.json(result.body, result.status);
        };
    };
}

export { paymentMiddleware };
