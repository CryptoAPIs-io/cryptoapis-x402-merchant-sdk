/**
 * Tests for the x402 v2 HTTP transport: the challenge in the `PAYMENT-REQUIRED` header,
 * the credential read from `PAYMENT-SIGNATURE`, the v2 payload shape that nests
 * scheme/network under `accepted`, and the explicit unsupported-network 402.
 *
 * The v1 path (body challenge + `X-PAYMENT`) must keep working throughout — our own
 * buyer SDK still speaks it. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    runPaymentGate, normalizePayload,
    PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_RESPONSE_V2_HEADER,
} from '../src/paymentGate.js';
import { buildPaymentRequirements } from '../src/paymentRequirements.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const resource = { url: 'https://api.example.test/premium' };

const baseReqs = buildPaymentRequirements({
    network: 'eip155:8453',
    asset: USDC_BASE,
    amount: '10000',
    payTo: '0xMerchant',
});
const solReqs = buildPaymentRequirements({
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: USDC_SOL,
    amount: '10000',
    payTo: 'SoLMerchant',
});

/** Base64-encode a payload as a header value. */
function b64(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Decode a base64 header value back to an object. */
function unb64(value) {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

/** A facilitator that always accepts, recording what it was asked to verify. */
function okFacilitator(calls = []) {
    return {
        calls,
        verify: async (args) => {
            calls.push(['verify', args]);
            return {
                isValid: true,
                payer: '0xBuyer'
            };
        },
        settle: async (args) => {
            calls.push(['settle', args]);
            return {
                success: true,
                payer: '0xBuyer',
                transaction: '0xdeadbeef'
            };
        },
    };
}

/** The v2 wire form: the chosen requirement echoed back under `accepted`. */
const v2Payload = {
    x402Version: 2,
    resource: resource,
    accepted: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: USDC_BASE,
        payTo: '0xMerchant',
    },
    payload: {
        signature: '0xsig',
        authorization: {}
    },
};

/** The v1 wire form: scheme/network flat on the payload. */
const v1Payload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
        signature: '0xsig',
        authorization: {}
    },
};

test('402 carries the challenge in the PAYMENT-REQUIRED header AND the body', async () => {
    const res = await runPaymentGate({
        resource: resource,
        accepts: [baseReqs],
        facilitator: okFacilitator(),
    });
    assert.equal(res.outcome, 'payment-required');
    assert.equal(res.status, 402);
    const header = res.headers?.[PAYMENT_REQUIRED_HEADER];
    assert.ok(header, 'PAYMENT-REQUIRED header must be present');
    // The header decodes to exactly the body — a v1 and a v2 client read identical terms.
    assert.deepEqual(unb64(header), res.body);
    assert.equal(res.body.x402Version, 2);
});

test('a v2 buyer pays via PAYMENT-SIGNATURE with scheme/network nested in `accepted`', async () => {
    const calls = [];
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(v2Payload),
        accepts: [baseReqs],
        facilitator: okFacilitator(calls),
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(res.status, 200);
    // It must have matched the Base requirement, not fallen through.
    assert.equal(calls[0][1].paymentRequirements.network, 'eip155:8453');
});

test('a v2 payload picks the RIGHT requirement on a multi-network merchant', async () => {
    const calls = [];
    const solPayload = {
        ...v2Payload,
        accepted: {
            ...v2Payload.accepted,
            network: solReqs.network,
            asset: USDC_SOL
        },
    };
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(solPayload),
        // Base listed FIRST — the old accepts[0] fallback would have picked it.
        accepts: [baseReqs, solReqs],
        facilitator: okFacilitator(calls),
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(calls[0][1].paymentRequirements.network, solReqs.network);
    assert.equal(calls[0][1].paymentRequirements.asset, USDC_SOL);
});

test('REGRESSION: a v1 buyer on X-PAYMENT still pays', async () => {
    const calls = [];
    const res = await runPaymentGate({
        resource: resource,
        paymentHeader: b64(v1Payload),
        accepts: [baseReqs],
        facilitator: okFacilitator(calls),
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(calls[0][1].paymentRequirements.network, 'eip155:8453');
});

test('PAYMENT-SIGNATURE wins when a buyer sends both headers', async () => {
    const calls = [];
    const stale = {
        ...v1Payload,
        network: solReqs.network
    };
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(v2Payload),
        paymentHeader: b64(stale),
        accepts: [baseReqs, solReqs],
        facilitator: okFacilitator(calls),
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(calls[0][1].paymentRequirements.network, 'eip155:8453');
});

test('a paid response carries BOTH the v1 and v2 receipt headers', async () => {
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(v2Payload),
        accepts: [baseReqs],
        facilitator: okFacilitator(),
    });
    assert.equal(res.outcome, 'paid');
    assert.ok(res.headers[PAYMENT_RESPONSE_HEADER]);
    assert.ok(res.headers[PAYMENT_RESPONSE_V2_HEADER]);
    assert.deepEqual(
        unb64(res.headers[PAYMENT_RESPONSE_V2_HEADER]),
        unb64(res.headers[PAYMENT_RESPONSE_HEADER])
    );
});

test('an unlisted network → 402 unsupported_network WITHOUT calling the facilitator', async () => {
    const calls = [];
    const offNetwork = {
        ...v2Payload,
        accepted: {
            ...v2Payload.accepted,
            network: 'eip155:1'
        }
    };
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(offNetwork),
        accepts: [baseReqs, solReqs],
        facilitator: okFacilitator(calls),
    });
    assert.equal(res.outcome, 'invalid');
    assert.equal(res.status, 402);
    assert.equal(res.reason, 'unsupported_network');
    // The buyer must never receive the facilitator's rejection of a requirement it never saw.
    assert.equal(calls.length, 0, 'facilitator must not be called on an unmatched network');
    // The 402 re-states every network the merchant DOES take.
    assert.deepEqual(res.body.accepts.map((r) => r.network), [baseReqs.network, solReqs.network]);
    assert.ok(res.headers[PAYMENT_REQUIRED_HEADER]);
});

test('an invalid payment 402 also carries the PAYMENT-REQUIRED header', async () => {
    const res = await runPaymentGate({
        resource: resource,
        signatureHeader: b64(v2Payload),
        accepts: [baseReqs],
        facilitator: {
            verify: async () => ({
                isValid: false,
                invalidReason: 'insufficient_funds'
            }),
            settle: async () => ({ success: false }),
        },
    });
    assert.equal(res.outcome, 'invalid');
    assert.equal(res.reason, 'insufficient_funds');
    assert.deepEqual(unb64(res.headers[PAYMENT_REQUIRED_HEADER]), res.body);
});

test('normalizePayload lifts scheme/network out of `accepted`, leaving v1 untouched', () => {
    assert.equal(normalizePayload(v2Payload).network, 'eip155:8453');
    assert.equal(normalizePayload(v2Payload).scheme, 'exact');
    assert.equal(normalizePayload(v1Payload), v1Payload);
    assert.equal(normalizePayload(null), null);
});
