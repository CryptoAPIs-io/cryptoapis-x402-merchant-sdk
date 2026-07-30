/**
 * A2A transport adapter (`@cryptoapis-io/x402-merchant-sdk/a2a`) — charge for an A2A SKILL.
 *
 * The third x402 transport, after `http` and `mcp`. Same core as both (`runPaymentGate`): per
 * `specs/transports-v2/a2a.md` a transport defines RESOURCE-SERVER <-> CLIENT signalling, so the
 * facilitator is untouched and `/verify` + `/settle` behave exactly as over HTTP.
 *
 * A2A is TASK-based rather than request/response, which makes it the most different of the three:
 *
 *  1. **Payment required is a TASK STATE.** Not a status code (http) or an `isError` result (mcp),
 *     but a task moved to `input-required`, carrying `x402.payment.status: "payment-required"` and
 *     the `PaymentRequired` body in `x402.payment.required` — both on the message's `metadata`.
 *  2. **Metadata keys are DOTTED STRINGS, not nested objects.** `metadata["x402.payment.required"]`
 *     — a literal key containing dots. Building it as `{x402:{payment:{required}}}` produces a
 *     shape no A2A client will read.
 *  3. **The payload carries `accepted`.** The client echoes back the requirement it chose, so the
 *     A2A `PaymentPayload` wraps `{resource, accepted, payload}` rather than the flat
 *     `{scheme, network, payload}` the HTTP/MCP forms use. Our facilitator reads either
 *     (`payload.scheme ?? payload.accepted?.scheme`), so both settle identically.
 *  4. **Receipts are an ARRAY** (`x402.payment.receipts`), not one settlement object — a task can
 *     accrue several payments over its lifetime.
 *  5. **Correlation is by `taskId`**, which the client must echo when submitting payment.
 */

import { runPaymentGate } from './paymentGate.js';
import { buildPaymentRequirements } from './paymentRequirements.js';
import { createFacilitatorClient } from './facilitatorClient.js';

/** Metadata keys defined by the A2A x402 extension. Literal dotted strings. @type {Object} */
const META = {
    STATUS: 'x402.payment.status',
    REQUIRED: 'x402.payment.required',
    PAYLOAD: 'x402.payment.payload',
    RECEIPTS: 'x402.payment.receipts',
    ERROR: 'x402.payment.error',
};

/** The `x402.payment.status` lifecycle values (spec: Payment Status Lifecycle). @type {Object} */
const STATUS = {
    REQUIRED: 'payment-required',
    REJECTED: 'payment-rejected',
    SUBMITTED: 'payment-submitted',
    VERIFIED: 'payment-verified',
    COMPLETED: 'payment-completed',
    FAILED: 'payment-failed',
};

/** A2A task states this adapter emits. @type {Object} */
const TASK_STATE = {
    INPUT_REQUIRED: 'input-required',
    COMPLETED: 'completed',
    FAILED: 'failed',
};

/** The extension URI an agent declares in its AgentCard and clients activate per-request. @type {string} */
const EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';

/** The header a client sends to activate the extension. @type {string} */
const EXTENSION_HEADER = 'X-A2A-Extensions';

/**
 * The `capabilities.extensions` entry an x402-charging agent must publish in its AgentCard.
 *
 * @param {boolean} [required] whether the agent REQUIRES the extension (default true — a paid
 *   agent is unusable to a client that cannot pay)
 * @return {{uri: string, description: string, required: boolean}} the AgentCard extension entry
 */
function agentCardExtension(required = true) {
    return {
        uri: EXTENSION_URI,
        description: 'Supports payments using the x402 protocol for on-chain settlement.',
        required: required,
    };
}

/**
 * Read the PaymentPayload a client attached to a message.
 *
 * Accepts the message, its `metadata`, or the JSON-RPC `params` — A2A servers differ in how much
 * of the envelope they hand a skill handler.
 *
 * @param {Object} [source] an A2A message, a metadata object, or `{message}` params
 * @return {(Object|null)} the PaymentPayload, or null when absent
 */
function readPaymentFromMessage(source) {
    const meta = source?.message?.metadata ?? source?.metadata ?? source;
    const payment = meta?.[META.PAYLOAD];
    return payment && typeof payment === 'object' ? payment : null;
}

/**
 * Normalize an A2A PaymentPayload to the flat form the gate matches on.
 *
 * The A2A wire form nests the chosen requirement under `accepted`; the gate pairs a payment to an
 * `accepts` entry by NETWORK, so lift `scheme`/`network` to the top when only `accepted` has them.
 * (The facilitator tolerates either, but the gate's matching must see the network.)
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
 * Build the `input-required` task status that asks the client to pay.
 *
 * @param {Object} body a PaymentRequired body (from build402Body, via the gate)
 * @param {string} [text] the human-readable prompt shown to the agent's user
 * @return {Object} an A2A task `status` object
 */
function paymentRequiredStatus(body, text = 'Payment is required to complete this request.') {
    return {
        state: TASK_STATE.INPUT_REQUIRED,
        message: {
            kind: 'message',
            role: 'agent',
            parts: [{
                kind: 'text',
                text: text
            }],
            metadata: {
                [META.STATUS]: STATUS.REQUIRED,
                [META.REQUIRED]: body,
            },
        },
    };
}

/**
 * Build the terminal task status for a payment that could not be settled.
 *
 * @param {Object} params inputs
 * @param {string} [params.reason] the spec error code (`invalidReason`/`errorReason`)
 * @param {string} [params.network] the network the payment named, when known
 * @param {string} [params.text] the human-readable explanation
 * @return {Object} an A2A task `status` object in the `failed` state
 */
function paymentFailedStatus({ reason, network, text } = {}) {
    return {
        state: TASK_STATE.FAILED,
        message: {
            kind: 'message',
            role: 'agent',
            parts: [{
                kind: 'text',
                text: text ?? `Payment failed: ${reason ?? 'unknown reason'}`
            }],
            metadata: {
                [META.STATUS]: STATUS.FAILED,
                ...(reason ? { [META.ERROR]: reason } : {}),
                // `transaction` is "" (never absent) on a failure, per x402 v2 §5.3.2.
                [META.RECEIPTS]: [{
                    success: false,
                    transaction: '',
                    ...(reason ? { errorReason: reason } : {}),
                    ...(network ? { network: network } : {}),
                }],
            },
        },
    };
}

/**
 * Build the terminal task status for a settled payment.
 *
 * @param {Object} settlement the facilitator's SettlementResponse
 * @param {string} [text] the human-readable confirmation
 * @return {Object} an A2A task `status` object in the `completed` state
 */
function paymentCompletedStatus(settlement, text = 'Payment successful.') {
    return {
        state: TASK_STATE.COMPLETED,
        message: {
            kind: 'message',
            role: 'agent',
            parts: [{
                kind: 'text',
                text: text
            }],
            metadata: {
                [META.STATUS]: STATUS.COMPLETED,
                // An ARRAY: a task may accrue several payments over its lifetime.
                [META.RECEIPTS]: [settlement],
            },
        },
    };
}

/**
 * Wrap an A2A skill handler so it is paid for with x402.
 *
 * @param {Object} params inputs
 * @param {string} [params.apiKey] CryptoAPIs API key with the X402_FACILITATOR feature
 *   (required unless a ready-made `facilitator` is injected)
 * @param {string} [params.payTo] default receiving address (override per skill via the price)
 * @param {string} [params.baseUrl] facilitator base URL override (QA/local)
 * @param {boolean} [params.settle] settle on-chain when true (default); false = verify-only
 * @param {Object} [params.facilitator] a pre-built facilitator client (tests/custom transport)
 * @return {Function} `paySkill(resource, price, handler)` → a wrapped A2A skill handler
 */
function paymentSkill({ apiKey, payTo: defaultPayTo, baseUrl, settle = true, facilitator } = {}) {
    const client = facilitator ?? createFacilitatorClient({
        apiKey: apiKey,
        baseUrl: baseUrl
    });

    /**
     * Wrap one skill.
     *
     * @param {(string|Object)} resource the resource being sold — a url string, or a full
     *   ResourceInfo `{url, description?, mimeType?}` (x402 v2 §5.1.2 requires `url`)
     * @param {(Object|Array<Object>)} price a price spec, or a list to offer several options
     * @param {Function} handler the real skill handler `(params, context) => taskResultOrArtifacts`
     * @return {Function} the wrapped handler with the same signature
     */
    return function paySkill(resource, price, handler) {
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
        const resourceInfo = typeof resource === 'string' ? { url: resource } : resource;

        return async function paidSkill(params, context) {
            // The payment rides on the message metadata; A2A servers pass the envelope
            // differently, so look in the params and in the handler's own context.
            const payment = normalizePayload(
                readPaymentFromMessage(params) ?? readPaymentFromMessage(context)
            );

            const result = await runPaymentGate({
                // The gate decodes a base64 HTTP header; A2A already has the object.
                payment: payment,
                accepts: accepts,
                resource: resourceInfo,
                facilitator: client,
                settle: settle,
            });

            if (result.outcome === 'payment-required') {
                return { status: paymentRequiredStatus(result.body) };
            }
            if (result.outcome !== 'paid') {
                // Presented but rejected — a TERMINAL `failed` state, not another ask. Re-asking
                // would loop a client that already paid what it was told to.
                return {
                    status: paymentFailedStatus({
                        reason: result.reason,
                        network: payment?.network,
                    }),
                };
            }

            const skillResult = await handler(params, context);

            // Settlement is already done by this point (the gate settles before returning
            // `paid`), so a paid task always carries its receipt.
            return {
                ...skillResult,
                status: paymentCompletedStatus(result.settlement),
            };
        };
    };
}

export {
    paymentSkill,
    agentCardExtension,
    paymentRequiredStatus,
    paymentCompletedStatus,
    paymentFailedStatus,
    readPaymentFromMessage,
    normalizePayload,
    META,
    STATUS,
    TASK_STATE,
    EXTENSION_URI,
    EXTENSION_HEADER,
};
