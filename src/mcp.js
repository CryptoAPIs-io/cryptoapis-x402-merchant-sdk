/**
 * MCP transport adapter (`@cryptoapis-io/x402-merchant-sdk/mcp`) — charge for an MCP TOOL.
 *
 * Same core as the HTTP adapters (`runPaymentGate`); only the envelope differs. Per
 * `specs/transports-v2/mcp.md` a transport defines RESOURCE-SERVER <-> CLIENT signalling —
 * the facilitator is untouched, so `/verify` and `/settle` behave exactly as over HTTP.
 *
 * Three differences from HTTP, all of them load-bearing:
 *
 *  1. **Payment required is a tool RESULT, not a status code.** `isError: true` carrying the
 *     `PaymentRequired` in BOTH `structuredContent` (the object) and `content[0].text`
 *     (`JSON.stringify` of the same object). The duplication is required by the spec so
 *     clients that cannot read structured content still get the payload.
 *  2. **No base64.** MCP carries structured JSON natively, so the payment arrives as a plain
 *     object in `_meta["x402/payment"]` — the HTTP `decodePaymentHeader` is bypassed.
 *  3. **A settlement failure AFTER the tool ran must withhold the tool's output.** The spec
 *     is explicit: return only the payment error. The merchant computed a result but was not
 *     paid, so serving it anyway would give the work away.
 */

import { runPaymentGate } from './paymentGate.js';
import { buildPaymentRequirements } from './paymentRequirements.js';
import { createFacilitatorClient } from './facilitatorClient.js';

/** `_meta` key the client sends the PaymentPayload under. @type {string} */
const PAYMENT_META_KEY = 'x402/payment';

/** `_meta` key the server returns the SettlementResponse under. @type {string} */
const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/**
 * The `mcp://tool/<name>` identifier the spec uses for a tool resource.
 *
 * @param {string} toolName the MCP tool name
 * @return {string} the resource url
 */
function mcpResourceUrl(toolName) {
    return `mcp://tool/${toolName}`;
}

/**
 * Read the PaymentPayload a client attached to a tool call.
 *
 * Accepts the params object (`{name, arguments, _meta}`) or a bare `_meta`, since MCP server
 * frameworks differ in how much of the request they hand a tool handler.
 *
 * @param {Object} [source] tool-call params, or a `_meta` object
 * @return {(Object|null)} the PaymentPayload, or null when absent
 */
function readPaymentFromMeta(source) {
    const meta = source?._meta ?? source;
    const payment = meta?.[PAYMENT_META_KEY];
    return payment && typeof payment === 'object' ? payment : null;
}

/**
 * Build the `isError: true` tool result carrying a PaymentRequired body.
 *
 * Emits the body twice — `structuredContent` and `content[0].text` — because the spec
 * REQUIRES both and states they must be identical.
 *
 * @param {Object} body a PaymentRequired body (from build402Body, via the gate)
 * @return {{isError: true, structuredContent: Object, content: Array<{type: string, text: string}>}} the tool result
 */
function paymentRequiredResult(body) {
    return {
        isError: true,
        structuredContent: body,
        content: [{
            type: 'text',
            text: JSON.stringify(body)
        }],
    };
}

/**
 * Wrap an MCP tool handler so it is paid for with x402.
 *
 * @param {Object} params inputs
 * @param {string} [params.apiKey] CryptoAPIs API key with the X402_FACILITATOR feature
 *   (required unless a ready-made `facilitator` is injected)
 * @param {string} [params.payTo] default receiving address (override per tool via the price)
 * @param {string} [params.baseUrl] facilitator base URL override (QA/local)
 * @param {boolean} [params.settle] settle on-chain when true (default); false = verify-only
 * @param {Object} [params.facilitator] a pre-built facilitator client (tests/custom transport)
 * @return {Function} `payTool(toolName, price, handler)` → a wrapped MCP tool handler
 */
function paymentTool({ apiKey, payTo: defaultPayTo, baseUrl, settle = true, facilitator } = {}) {
    const client = facilitator ?? createFacilitatorClient({
        apiKey: apiKey,
        baseUrl: baseUrl
    });

    /**
     * Wrap one tool.
     *
     * @param {string} toolName the tool's registered name (becomes `mcp://tool/<name>`)
     * @param {(Object|Array<Object>)} price a price spec, or a list to offer several options
     * @param {Function} handler the real tool handler `(args, extra) => toolResult`
     * @return {Function} the wrapped handler with the same signature
     */
    return function payTool(toolName, price, handler) {
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
        // A merchant MAY state the resource explicitly (to add description/mimeType);
        // otherwise it is the spec's mcp://tool/<name> identifier.
        const declared = specs.find((s) => s.resource)?.resource;
        const resource = declared ?? { url: mcpResourceUrl(toolName) };

        return async function paidTool(args, extra) {
            // The payment rides on the tool call's _meta; frameworks pass it differently, so
            // look in the handler's own `extra` and in the raw args as a fallback.
            const payment = readPaymentFromMeta(extra) ?? readPaymentFromMeta(args);

            const result = await runPaymentGate({
                // The gate decodes a base64 HTTP header; MCP already has the object, so hand
                // it over pre-decoded.
                payment: payment,
                accepts: accepts,
                resource: resource,
                facilitator: client,
                settle: settle,
            });

            if (result.outcome !== 'paid') {
                // Covers BOTH "no payment" and "verify/settle rejected it" — the spec uses
                // the same PaymentRequired shape for each, the reason carried in `error`.
                return paymentRequiredResult(result.body);
            }

            const toolResult = await handler(args, extra);

            // Settlement is already done by this point (the gate settles before returning
            // `paid`), so a paid tool result always carries its receipt.
            return {
                ...toolResult,
                _meta: {
                    ...(toolResult?._meta ?? {}),
                    [PAYMENT_RESPONSE_META_KEY]: result.settlement,
                },
            };
        };
    };
}

export {
    paymentTool,
    paymentRequiredResult,
    readPaymentFromMeta,
    mcpResourceUrl,
    PAYMENT_META_KEY,
    PAYMENT_RESPONSE_META_KEY,
};
