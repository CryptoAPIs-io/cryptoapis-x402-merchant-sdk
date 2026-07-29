/**
 * MCP transport adapter (specs/transports-v2/mcp.md). Covers the three things that make
 * MCP different from HTTP: the dual-format payment-required result, the raw-JSON payment
 * in `_meta` (no base64), and the settlement receipt on a paid result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    paymentTool, paymentRequiredResult, readPaymentFromMeta, mcpResourceUrl,
    PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY
} from '../src/mcp.js';

const PRICE = {
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0xMerchant',
};

const validPayload = () => ({
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
        signature: '0xsig',
        authorization: {}
    },
});

/** A facilitator whose verify/settle outcomes are scripted. */
const fac = ({ isValid = true, success = true, invalidReason, errorReason } = {}) => ({
    verify: async () => ({
        isValid,
        payer: '0xBuyer',
        ...(invalidReason ? { invalidReason } : {})
    }),
    settle: async () => ({
        success,
        payer: '0xBuyer',
        transaction: '0xtx',
        network: 'eip155:8453',
        ...(errorReason ? { errorReason } : {}),
    }),
});

test('no payment → isError result carrying PaymentRequired in BOTH formats', async () => {
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac()
    })(
        'financial_analysis', PRICE, async () => ({
            content: [{
                type: 'text',
                text: 'secret'
            }]
        })
    );
    const res = await tool({ ticker: 'AAPL' }, {});

    assert.equal(res.isError, true);
    // Spec: structuredContent AND content[0].text, identical data.
    assert.equal(res.structuredContent.x402Version, 2);
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
    // The tool must NOT have run.
    assert.equal(res.content.length, 1);
});

test('the PaymentRequired carries the mcp://tool/<name> resource', async () => {
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac()
    })(
        'financial_analysis', PRICE, async () => ({ content: []})
    );
    const res = await tool({}, {});
    assert.equal(res.structuredContent.resource.url, 'mcp://tool/financial_analysis');
    assert.equal(mcpResourceUrl('x'), 'mcp://tool/x');
});

test('payment arrives as a RAW OBJECT in _meta — no base64 decoding', async () => {
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac()
    })(
        'analysis', PRICE, async () => ({
            content: [{
                type: 'text',
                text: 'result'
            }]
        })
    );
    const res = await tool({}, { _meta: { [PAYMENT_META_KEY]: validPayload() } });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, 'result');
});

test('a paid result carries the settlement in _meta["x402/payment-response"]', async () => {
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac()
    })(
        'analysis', PRICE, async () => ({
            content: [{
                type: 'text',
                text: 'result'
            }]
        })
    );
    const res = await tool({}, { _meta: { [PAYMENT_META_KEY]: validPayload() } });
    const receipt = res._meta[PAYMENT_RESPONSE_META_KEY];
    assert.equal(receipt.success, true);
    assert.equal(receipt.transaction, '0xtx');
    assert.equal(receipt.network, 'eip155:8453');
});

test('a failed VERIFY returns PaymentRequired and never runs the tool', async () => {
    let ran = false;
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac({
            isValid: false,
            invalidReason: 'invalid_exact_evm_payload_signature'
        }),
    })('analysis', PRICE, async () => { ran = true; return { content: []}; });

    const res = await tool({}, { _meta: { [PAYMENT_META_KEY]: validPayload() } });
    assert.equal(res.isError, true);
    assert.equal(ran, false); // the merchant did no work
    assert.equal(res.structuredContent.error, 'invalid_exact_evm_payload_signature');
});

test('a failed SETTLE withholds the tool output entirely', async () => {
    // Spec: "If settlement fails after the tool has already executed, the server should not
    // return the tool's content - only the payment error." The gate settles BEFORE the
    // handler runs, so the secret is never computed, let alone returned.
    let ran = false;
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac({
            success: false,
            errorReason: 'invalid_transaction_state'
        }),
    })('analysis', PRICE, async () => {
        ran = true; return {
            content: [{
                type: 'text',
                text: 'secret'
            }]
        };
    });

    const res = await tool({}, { _meta: { [PAYMENT_META_KEY]: validPayload() } });
    assert.equal(res.isError, true);
    assert.equal(ran, false);
    assert.equal(JSON.stringify(res).includes('secret'), false);
});

test('reads the payment from params._meta as well as from extra', async () => {
    // MCP server frameworks differ in what they hand a tool handler.
    const p = validPayload();
    assert.deepEqual(readPaymentFromMeta({ _meta: { [PAYMENT_META_KEY]: p } }), p);
    assert.deepEqual(readPaymentFromMeta({ [PAYMENT_META_KEY]: p }), p);
    assert.equal(readPaymentFromMeta({}), null);
    assert.equal(readPaymentFromMeta(undefined), null);
});

test('preserves any _meta the tool itself returned', async () => {
    const tool = paymentTool({
        payTo: '0xM',
        facilitator: fac()
    })(
        'analysis', PRICE, async () => ({
            content: [],
            _meta: { 'my/own': 'kept' }
        })
    );
    const res = await tool({}, { _meta: { [PAYMENT_META_KEY]: validPayload() } });
    assert.equal(res._meta['my/own'], 'kept');
    assert.ok(res._meta[PAYMENT_RESPONSE_META_KEY]);
});

test('paymentRequiredResult duplicates the body verbatim', () => {
    const body = {
        x402Version: 2,
        resource: { url: 'mcp://tool/t' },
        accepts: []
    };
    const r = paymentRequiredResult(body);
    assert.equal(r.isError, true);
    assert.deepEqual(r.structuredContent, body);
    assert.equal(r.content[0].type, 'text');
    assert.deepEqual(JSON.parse(r.content[0].text), body);
});
