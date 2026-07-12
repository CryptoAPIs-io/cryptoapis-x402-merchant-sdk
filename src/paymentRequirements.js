/**
 * Build the x402 `PaymentRequirements` a merchant returns in the HTTP 402 body so a
 * buyer's client knows exactly what to pay. Shape (from `@cryptoapis/x402-core`):
 *   { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }
 *
 * `amount` is the atomic-unit price (e.g. USDC 6-decimals: "10000" = $0.01). `asset`
 * is the token contract/mint (or the `native` sentinel). `network` is CAIP-2
 * (e.g. `eip155:8453` Base). `payTo` is the merchant's receiving address.
 */

/** The only scheme supported in v1. @type {string} */
const SCHEME_EXACT = 'exact';

/**
 * Build a normalized PaymentRequirements object for a priced resource.
 *
 * @param {Object} params inputs
 * @param {string} params.network CAIP-2 network id (e.g. `eip155:8453`)
 * @param {string} params.asset token contract/mint, or `native`
 * @param {(string|number|bigint)} params.amount atomic-unit price (smallest unit)
 * @param {string} params.payTo the merchant's receiving address
 * @param {number} [params.maxTimeoutSeconds] how long the payment authorization stays valid (default 300)
 * @param {Object} [params.extra] family-specific extra (e.g. SVM `{ feePayer, decimals, tokenProgram }`)
 * @param {string} [params.scheme] the scheme (default `exact`)
 * @return {{scheme: string, network: string, amount: string, asset: string, payTo: string, maxTimeoutSeconds: number, extra: Object}} the requirements
 */
function buildPaymentRequirements({
    network, asset, amount, payTo, maxTimeoutSeconds = 300, extra = {}, scheme = SCHEME_EXACT,
}) {
    if (!network || !asset || amount == null || !payTo) {
        throw new Error('buildPaymentRequirements: network, asset, amount, payTo are required');
    }
    return {
        scheme: scheme,
        network: network,
        amount: String(amount),
        asset: asset,
        payTo: payTo,
        maxTimeoutSeconds: maxTimeoutSeconds,
        extra: extra,
    };
}

/**
 * Build the HTTP 402 response body a merchant returns when payment is required. The
 * x402 standard body carries `x402Version` + the `accepts` list of acceptable
 * PaymentRequirements (a merchant MAY offer more than one asset/network).
 *
 * @param {Object} params inputs
 * @param {Array<Object>} params.accepts one or more PaymentRequirements (see buildPaymentRequirements)
 * @param {string} [params.error] optional human-readable reason (e.g. "payment required")
 * @return {{x402Version: number, accepts: Array<Object>, error?: string}} the 402 body
 */
function build402Body({ accepts, error }) {
    if (!Array.isArray(accepts) || accepts.length === 0) {
        throw new Error('build402Body: at least one accepts entry is required');
    }
    return {
        x402Version: 2,
        accepts: accepts,
        ...(error ? { error } : {}),
    };
}

export {
    buildPaymentRequirements, build402Body, SCHEME_EXACT
};
