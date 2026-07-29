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
 * Build the `PaymentRequired` body a merchant returns when payment is required — the HTTP
 * 402 body, and the same object an MCP tool puts in `structuredContent` (the schema is
 * transport-independent; only the envelope differs).
 *
 * Per x402 v2 §5.1.2 the REQUIRED fields are `x402Version`, `resource` and `accepts`;
 * `error` and `extensions` are optional. `resource` is a ResourceInfo whose `url` is
 * itself required — so both are enforced here rather than accepted as optional. Emitting a
 * body without them would be non-conformant, and a client written against the spec may
 * read `resource.url` unconditionally.
 *
 * @param {Object} params inputs
 * @param {Array<Object>} params.accepts one or more PaymentRequirements (see buildPaymentRequirements)
 * @param {{url: string, description?: string, mimeType?: string}} params.resource REQUIRED
 *   ResourceInfo describing what is being paid for. `url` is required (HTTP: the endpoint
 *   url; MCP: `mcp://tool/<name>`); description/mimeType are optional.
 * @param {string} [params.error] optional human-readable reason (e.g. "payment required")
 * @param {Object} [params.extensions] optional protocol extensions data
 * @return {{x402Version: number, resource: Object, accepts: Array<Object>, error?: string, extensions?: Object}} the PaymentRequired body
 */
function build402Body({ accepts, resource, error, extensions }) {
    if (!Array.isArray(accepts) || accepts.length === 0) {
        throw new Error('build402Body: at least one accepts entry is required');
    }
    // Fail loudly rather than emit a body missing a REQUIRED field: a silent omission is
    // exactly how a non-conformant response reaches a client that then breaks on it.
    if (!resource || typeof resource.url !== 'string' || resource.url === '') {
        throw new Error('build402Body: resource.url is required (x402 v2 §5.1.2 — PaymentRequired.resource)');
    }
    return {
        x402Version: 2,
        resource: {
            url: resource.url,
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        },
        accepts: accepts,
        ...(error ? { error } : {}),
        ...(extensions ? { extensions } : {}),
    };
}

export {
    buildPaymentRequirements, build402Body, SCHEME_EXACT
};
