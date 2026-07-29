/**
 * Tests for the framework-agnostic x402 payment gate: the three outcomes
 * (payment-required / paid / invalid) with a mocked facilitator, header
 * encode/decode, and the accepts-matching by (scheme, network). `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    runPaymentGate, decodePaymentHeader, encodePaymentResponse, PAYMENT_RESPONSE_HEADER,
} from '../src/paymentGate.js';
import { buildPaymentRequirements } from '../src/paymentRequirements.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reqs = buildPaymentRequirements({
    network: 'eip155:8453',
    asset: USDC,
    amount: '10000',
    payTo: '0xMerchant',
});

/**
 * Base64-encode a PaymentPayload as the X-PAYMENT header value.
 * @param payload
 */
function payHeader(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** A payment payload matching the requirements' scheme+network. */
const validPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
        signature: '0xsig',
        authorization: {}
    }
};

test('no X-PAYMENT header → payment-required (402 + accepts body)', async () => {
    const res = await runPaymentGate({
        paymentHeader: undefined,
        accepts: [reqs],
        facilitator: {}
    });
    assert.equal(res.outcome, 'payment-required');
    assert.equal(res.status, 402);
    assert.equal(res.body.x402Version, 2);
    assert.deepEqual(res.body.accepts, [reqs]);
});

test('empty header → payment-required', async () => {
    const res = await runPaymentGate({
        paymentHeader: '',
        accepts: [reqs],
        facilitator: {}
    });
    assert.equal(res.outcome, 'payment-required');
});

test('valid payment → verify + settle → paid (200 + X-PAYMENT-RESPONSE)', async () => {
    const calls = [];
    const facilitator = {
        verify: async (a) => {
            calls.push(['verify', a]); return {
                isValid: true,
                payer: '0xBuyer'
            };
        },
        settle: async (a) => {
            calls.push(['settle', a]); return {
                success: true,
                payer: '0xBuyer',
                transaction: '0xtx',
                network: 'eip155:8453'
            };
        },
    };
    const res = await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [reqs],
        facilitator
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(res.status, 200);
    assert.equal(res.payer, '0xBuyer');
    assert.equal(res.settlement.transaction, '0xtx');
    // X-PAYMENT-RESPONSE header carries the settlement (base64)
    const decoded = JSON.parse(Buffer.from(res.headers[PAYMENT_RESPONSE_HEADER], 'base64').toString('utf8'));
    assert.equal(decoded.transaction, '0xtx');
    // both facilitator calls used the matched requirements + payload
    assert.equal(calls[0][0], 'verify');
    assert.equal(calls[1][0], 'settle');
    assert.deepEqual(calls[0][1].paymentRequirements, reqs);
});

test('verify rejects → invalid (402, reason surfaced)', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: false,
            invalidReason: 'insufficient_funds'
        }),
        settle: async () => { throw new Error('settle must NOT be called when verify fails'); },
    };
    const res = await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [reqs],
        facilitator
    });
    assert.equal(res.outcome, 'invalid');
    assert.equal(res.status, 402);
    assert.equal(res.reason, 'insufficient_funds');
    assert.equal(res.body.error, 'insufficient_funds');
});

test('verify ok but settle fails → invalid (settlement_failed)', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: true,
            payer: '0xBuyer'
        }),
        settle: async () => ({
            success: false,
            errorReason: 'broadcast_rejected'
        }),
    };
    const res = await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [reqs],
        facilitator
    });
    assert.equal(res.outcome, 'invalid');
    assert.equal(res.reason, 'broadcast_rejected');
});

test('settle fails with NO errorReason → falls back to the spec code', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: true,
            payer: '0xBuyer'
        }),
        // A facilitator that omits errorReason entirely (spec marks it Optional).
        settle: async () => ({ success: false }),
    };
    const res = await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [reqs],
        facilitator
    });
    assert.equal(res.outcome, 'invalid');
    // The fallback must be a code from x402 v2 §9, not an invented one — a merchant
    // branching on this string should never meet a non-standard value from us.
    assert.equal(res.reason, 'invalid_transaction_state');
});

test('settle:false → verify-only advisory paid (no settle call)', async () => {
    let settleCalled = false;
    const facilitator = {
        verify: async () => ({
            isValid: true,
            payer: '0xBuyer'
        }),
        settle: async () => { settleCalled = true; return {}; },
    };
    const res = await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [reqs],
        facilitator,
        settle: false
    });
    assert.equal(res.outcome, 'paid');
    assert.equal(res.payer, '0xBuyer');
    assert.equal(settleCalled, false);
});

test('accepts-matching: picks the requirement whose scheme+network matches the payload', async () => {
    const solReqs = buildPaymentRequirements({
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        asset: 'MINT',
        amount: '1',
        payTo: 'sol'
    });
    let seen;
    const facilitator = {
        verify: async (a) => {
            seen = a.paymentRequirements; return {
                isValid: true,
                payer: 'p'
            };
        },
        settle: async () => ({ success: true }),
    };
    // payload is EVM → must match the EVM requirement, not the Solana one
    await runPaymentGate({
        paymentHeader: payHeader(validPayload),
        accepts: [solReqs, reqs],
        facilitator
    });
    assert.equal(seen.network, 'eip155:8453');
});

test('malformed base64 header → treated as no payment (payment-required)', async () => {
    const res = await runPaymentGate({
        paymentHeader: '!!!not-base64-json!!!',
        accepts: [reqs],
        facilitator: {}
    });
    assert.equal(res.outcome, 'payment-required');
});

test('decode/encode header round-trip', () => {
    assert.equal(decodePaymentHeader(payHeader(validPayload)).scheme, 'exact');
    assert.equal(decodePaymentHeader(undefined), null);
    const enc = encodePaymentResponse({
        success: true,
        transaction: '0xtx'
    });
    assert.equal(JSON.parse(Buffer.from(enc, 'base64').toString('utf8')).transaction, '0xtx');
});
