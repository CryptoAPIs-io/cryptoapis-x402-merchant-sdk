/**
 * The framework-agnostic x402 payment gate. Given a request's `X-PAYMENT` header and
 * the price for the resource, it decides one of three outcomes:
 *   - `payment-required` — no/empty payment header → the caller returns HTTP 402 + body.
 *   - `paid`             — payment verified AND settled → the caller serves the resource,
 *                          echoing the settlement in the `X-PAYMENT-RESPONSE` header.
 *   - `invalid`          — a payment was presented but verify/settle rejected it → 402.
 *
 * This is transport-agnostic: framework adapters (express.js) translate the outcome
 * into that framework's response. The gate NEVER holds keys and NEVER signs — it only
 * relays the buyer's signed payload to the facilitator.
 *
 * The `X-PAYMENT` header is the base64-encoded x402 `PaymentPayload`
 * ({ x402Version, scheme, network, payload }) the buyer's client attaches on retry.
 */

import { build402Body } from './paymentRequirements.js';

/**
 * x402 header names. The v2 HTTP transport carries ALL protocol information in headers
 * (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) and treats the response
 * body as a server implementation concern. v1 put the challenge in the body and the
 * credential in `X-PAYMENT`.
 *
 * We emit and accept BOTH: the v2 headers go out beside the v1 body, and the credential
 * is read from `PAYMENT-SIGNATURE` first, falling back to `X-PAYMENT`. That makes a
 * v2-transport buyer able to pay without breaking any buyer already sending v1.
 */
const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'x-payment-response';
const PAYMENT_SIGNATURE_HEADER = 'payment-signature';
const PAYMENT_REQUIRED_HEADER = 'payment-required';
const PAYMENT_RESPONSE_V2_HEADER = 'payment-response';

/**
 * Decode the base64 `X-PAYMENT` header into a PaymentPayload object.
 *
 * @param {(string|undefined)} headerValue the raw header value
 * @return {Object|null} the parsed PaymentPayload, or null if absent/malformed
 */
function decodePaymentHeader(headerValue) {
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
        return null;
    }
    try {
        return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Encode a settlement result as the base64 `X-PAYMENT-RESPONSE` header value.
 *
 * @param {Object} settleResult the facilitator settle result
 * @return {string} the base64 header value
 */
function encodePaymentResponse(settleResult) {
    return Buffer.from(JSON.stringify(settleResult), 'utf8').toString('base64');
}

/**
 * Encode a PaymentRequired body as the base64 `PAYMENT-REQUIRED` header value. The v2
 * transport carries the BARE object (no envelope) — the same object we also put in the
 * body, so a v1 and a v2 client read identical terms.
 *
 * @param {Object} body the PaymentRequired body (from build402Body)
 * @return {string} the base64 header value
 */
function encodePaymentRequired(body) {
    return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

/**
 * Normalize a PaymentPayload to the flat form the gate matches on.
 *
 * The v2 wire form (and A2A) nests the chosen requirement under `accepted`; v1 put
 * `scheme`/`network` at the top level. The gate pairs a payment to an `accepts` entry by
 * NETWORK, so lift them when only `accepted` has them — otherwise `payload.network` is
 * undefined for every v2 buyer and the match silently falls through.
 * (The facilitator tolerates either shape, but the gate's matching must see the network.)
 *
 * @param {(Object|null)} payment the payload as it arrived
 * @return {(Object|null)} the payload with scheme/network at the top level
 */
function normalizePayload(payment) {
    if (!payment) {
        return null;
    }
    if (payment.scheme && payment.network) {
        return payment;
    }
    return {
        ...payment,
        scheme: payment.scheme ?? payment.accepted?.scheme,
        network: payment.network ?? payment.accepted?.network,
    };
}

/**
 * Build the shared parts of a 402 outcome: the v1 body AND the v2 `PAYMENT-REQUIRED`
 * header, from one PaymentRequired object so the two can never disagree.
 *
 * @param {Object} params inputs
 * @param {Array<Object>} params.accepts the acceptable PaymentRequirements
 * @param {Object} params.resource the REQUIRED ResourceInfo for the protected resource
 * @param {string} [params.error] human-readable reason
 * @return {{status: number, body: Object, headers: Object}} the 402 status/body/headers
 */
function paymentRequired({ accepts, resource, error }) {
    const body = build402Body({
        accepts: accepts,
        resource: resource,
        error: error
    });
    return {
        status: 402,
        body: body,
        headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequired(body) },
    };
}

/**
 * Run the x402 gate for a single request.
 *
 * @param {Object} params inputs
 * @param {(string|undefined)} [params.paymentHeader] the raw base64 `X-PAYMENT` request header (v1 HTTP)
 * @param {(string|undefined)} [params.signatureHeader] the raw base64 `PAYMENT-SIGNATURE` request
 *   header (v2 HTTP) — preferred over `paymentHeader` when both are present
 * @param {(Object|null)} [params.payment] an ALREADY-DECODED PaymentPayload (MCP, which carries
 *   it as structured JSON in `_meta` — pass this instead of paymentHeader)
 * @param {Array<Object>} params.accepts the acceptable PaymentRequirements for this resource
 * @param {Object} params.resource REQUIRED ResourceInfo `{url, description?, mimeType?}` for the
 *   protected resource — x402 v2 §5.1.2 makes it mandatory on every PaymentRequired body
 * @param {Object} params.facilitator a facilitatorClient (verify/settle)
 * @param {boolean} [params.settle] settle on-chain when true (default true); false = verify-only (advisory)
 * @return {Promise<{outcome: 'payment-required'|'paid'|'invalid', status: number, body?: Object, headers?: Object, payer?: string, settlement?: Object, reason?: string, requirements?: Object}>} the gate decision
 */
async function runPaymentGate({
    paymentHeader, signatureHeader, payment, accepts, resource, facilitator, settle = true,
}) {
    // HTTP hands us a base64 header; MCP already has the PaymentPayload as a plain object
    // (it rides in `_meta`, and the transport carries structured JSON natively). Accept
    // either so both transports share this core untouched.
    // v2 `PAYMENT-SIGNATURE` wins over v1 `X-PAYMENT`; MCP hands us the object directly.
    // normalizePayload lifts scheme/network out of the v2 `accepted` wrapper so the
    // network match below works for a v2 and a v1 payload alike.
    const payload = normalizePayload(
        payment ?? decodePaymentHeader(signatureHeader) ?? decodePaymentHeader(paymentHeader)
    );
    if (!payload) {
        return {
            outcome: 'payment-required',
            ...paymentRequired({
                accepts: accepts,
                resource: resource,
                error: 'payment required'
            }),
        };
    }

    // Match the presented payment to one of the acceptable requirements by NETWORK.
    // The wire `paymentPayload.scheme` is ALWAYS `exact` (the family is carried by
    // `network`, per the facilitator's parseEnvelope) — so scheme can't disambiguate;
    // network is the pairing key. A merchant offering >1 asset on the SAME network
    // should list the fuller-priced/native asset first (the buyer picks a network,
    // the facilitator validates the asset against that requirement).
    const requirements = accepts.find((r) => r.network === payload.network);
    // No match → say so plainly, with the full accepts list, WITHOUT calling the
    // facilitator. Falling back to accepts[0] here would send the buyer the
    // facilitator's rejection of a requirement it never saw.
    if (!requirements) {
        return {
            outcome: 'invalid',
            reason: 'unsupported_network',
            ...paymentRequired({
                accepts: accepts,
                resource: resource,
                error: `unsupported network "${payload.network ?? 'unknown'}"`
            }),
        };
    }

    const verifyResult = await facilitator.verify({
        paymentRequirements: requirements,
        paymentPayload: payload,
    });
    if (!verifyResult?.isValid) {
        return {
            outcome: 'invalid',
            reason: verifyResult?.invalidReason ?? 'invalid_payment',
            ...paymentRequired({
                accepts: accepts,
                resource: resource,
                error: verifyResult?.invalidReason ?? 'invalid payment'
            }),
        };
    }

    if (!settle) {
        // Verify-only mode: advisory (no on-chain settlement). Rare — most merchants settle.
        return {
            outcome: 'paid',
            status: 200,
            payer: verifyResult.payer,
        };
    }

    const settleResult = await facilitator.settle({
        paymentRequirements: requirements,
        paymentPayload: payload,
    });
    if (!settleResult?.success) {
        return {
            outcome: 'invalid',
            // Spec code (x402 v2 §9). Only a fallback — the facilitator normally supplies
            // `errorReason` already translated; this covers a response that omits it.
            reason: settleResult?.errorReason ?? 'invalid_transaction_state',
            ...paymentRequired({
                accepts: accepts,
                resource: resource,
                error: settleResult?.errorReason ?? 'settlement failed'
            }),
        };
    }

    return {
        outcome: 'paid',
        status: 200,
        payer: settleResult.payer,
        settlement: settleResult,
        headers: {
            [PAYMENT_RESPONSE_HEADER]: encodePaymentResponse(settleResult),
            [PAYMENT_RESPONSE_V2_HEADER]: encodePaymentResponse(settleResult),
        },
    };
}

export {
    runPaymentGate,
    decodePaymentHeader,
    encodePaymentResponse,
    encodePaymentRequired,
    normalizePayload,
    PAYMENT_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_V2_HEADER,
};
