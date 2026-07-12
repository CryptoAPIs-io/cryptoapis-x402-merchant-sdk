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

/** Standard x402 header names. */
const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

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
 * Run the x402 gate for a single request.
 *
 * @param {Object} params inputs
 * @param {(string|undefined)} params.paymentHeader the raw `X-PAYMENT` request header
 * @param {Array<Object>} params.accepts the acceptable PaymentRequirements for this resource
 * @param {Object} params.facilitator a facilitatorClient (verify/settle)
 * @param {boolean} [params.settle] settle on-chain when true (default true); false = verify-only (advisory)
 * @return {Promise<{outcome: 'payment-required'|'paid'|'invalid', status: number, body?: Object, headers?: Object, payer?: string, settlement?: Object, reason?: string, requirements?: Object}>} the gate decision
 */
async function runPaymentGate({ paymentHeader, accepts, facilitator, settle = true }) {
    const payload = decodePaymentHeader(paymentHeader);
    if (!payload) {
        return {
            outcome: 'payment-required',
            status: 402,
            body: build402Body({
                accepts: accepts,
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
    const requirements = accepts.find((r) => r.network === payload.network) ?? accepts[0];

    const verifyResult = await facilitator.verify({
        paymentRequirements: requirements,
        paymentPayload: payload,
    });
    if (!verifyResult?.isValid) {
        return {
            outcome: 'invalid',
            status: 402,
            reason: verifyResult?.invalidReason ?? 'invalid_payment',
            body: build402Body({
                accepts: accepts,
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
            status: 402,
            reason: settleResult?.errorReason ?? 'settlement_failed',
            body: build402Body({
                accepts: accepts,
                error: settleResult?.errorReason ?? 'settlement failed'
            }),
        };
    }

    return {
        outcome: 'paid',
        status: 200,
        payer: settleResult.payer,
        settlement: settleResult,
        headers: { [PAYMENT_RESPONSE_HEADER]: encodePaymentResponse(settleResult) },
    };
}

export {
    runPaymentGate,
    decodePaymentHeader,
    encodePaymentResponse,
    PAYMENT_HEADER,
    PAYMENT_RESPONSE_HEADER,
};
