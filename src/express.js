/**
 * Express middleware for x402 — monetize a route in ~3 lines:
 *
 *   import { paymentMiddleware } from '@cryptoapis-io/x402-merchant-sdk/express';
 *   const pay = paymentMiddleware({ apiKey: process.env.CRYPTOAPIS_API_KEY, payTo: '0x…' });
 *   app.get('/premium', pay({ network: 'eip155:8453', asset: USDC, amount: '10000' }), handler);
 *
 * On a request with no valid `X-PAYMENT`, it responds 402 with the PaymentRequirements
 * the buyer needs to pay. On a valid, settled payment it attaches `req.x402` (the
 * settlement + payer), sets the `X-PAYMENT-RESPONSE` header, and calls `next()`.
 */

import { createFacilitatorClient } from './facilitatorClient.js';
import { buildPaymentRequirements } from './paymentRequirements.js';
import {
    runPaymentGate, PAYMENT_HEADER
} from './paymentGate.js';

/**
 * Build an Express payment-middleware factory bound to a merchant + facilitator.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the merchant's CryptoAPIs API key (X402_FACILITATOR feature)
 * @param {string} [params.payTo] default receiving address for all routes (overridable per-route)
 * @param {string} [params.baseUrl] facilitator base URL override (QA/local)
 * @param {boolean} [params.settle] settle on-chain (default true)
 * @param {Object} [params.facilitator] a pre-built facilitatorClient (injectable for tests)
 * @return {Function} `pay(priceOpts | priceOpts[])` → an Express middleware
 */
function paymentMiddleware({ apiKey, payTo: defaultPayTo, baseUrl, settle = true, facilitator } = {}) {
    const client = facilitator ?? createFacilitatorClient({
        apiKey,
        baseUrl
    });

    /**
     * Create the middleware for a priced route. Accepts one price spec or an array
     * (to offer several assets/networks — the `accepts` list in the 402).
     *
     * @param {(Object|Array<Object>)} price a price spec (network, asset, amount, payTo?, extra?) or a list
     * @return {Function} the Express middleware `(req, res, next)`
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

        return async function x402Middleware(req, res, next) {
            try {
                const result = await runPaymentGate({
                    paymentHeader: req.headers[PAYMENT_HEADER],
                    accepts: accepts,
                    facilitator: client,
                    settle: settle,
                });
                if (result.outcome === 'paid') {
                    if (result.headers) {
                        for (const [k, v] of Object.entries(result.headers)) {
                            res.set(k, v);
                        }
                    }
                    req.x402 = {
                        payer: result.payer,
                        settlement: result.settlement
                    };
                    next();
                    return;
                }
                // payment-required or invalid → 402 with the requirements body.
                res.status(result.status).json(result.body);
            } catch (err) {
                // A facilitator transport/auth error is a 502 (the merchant's dependency
                // is down), NOT a 402 (the buyer did nothing wrong).
                next(err instanceof Error ? err : new Error(String(err)));
            }
        };
    };
}

export { paymentMiddleware };
