/**
 * Tests for the facilitator client: it posts { paymentRequirements, paymentPayload }
 * with the x-api-key, parses the body, and throws on non-2xx. Mocked fetch.
 * `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFacilitatorClient } from '../src/facilitatorClient.js';

/**
 * A fetch mock returning `body` with `status`. Captures the last call.
 * @param body
 * @param status
 */
function mockFetch(body, status = 200) {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({
            url,
            opts
        });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    };
    fn.calls = calls;
    return fn;
}

test('requires an apiKey', () => {
    assert.throws(() => createFacilitatorClient({}), /apiKey is required/);
});

test('verify posts to /verify with x-api-key + body, returns parsed result', async () => {
    const fetchImpl = mockFetch({
        isValid: true,
        payer: '0xBuyer'
    });
    const c = createFacilitatorClient({
        apiKey: 'KEY123',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    const res = await c.verify({
        paymentRequirements: { a: 1 },
        paymentPayload: { b: 2 }
    });
    assert.deepEqual(res, {
        isValid: true,
        payer: '0xBuyer'
    });
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://fac/x402/merchant/verify');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers['x-api-key'], 'KEY123');
    assert.deepEqual(JSON.parse(call.opts.body), {
        paymentRequirements: { a: 1 },
        paymentPayload: { b: 2 }
    });
});

test('settle posts to /settle', async () => {
    const fetchImpl = mockFetch({
        success: true,
        transaction: '0xtx'
    });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    const res = await c.settle({
        paymentRequirements: {},
        paymentPayload: {}
    });
    assert.equal(res.transaction, '0xtx');
    assert.equal(fetchImpl.calls[0].url, 'https://fac/x402/merchant/settle');
});

test('trailing slash in baseUrl is normalized', async () => {
    const fetchImpl = mockFetch({ isValid: true });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant/',
        fetchImpl
    });
    await c.verify({
        paymentRequirements: {},
        paymentPayload: {}
    });
    assert.equal(fetchImpl.calls[0].url, 'https://fac/x402/merchant/verify');
});

test('non-2xx throws (transport/auth error, not a protocol result)', async () => {
    const fetchImpl = mockFetch({ error: 'no_x402_access' }, 403);
    const c = createFacilitatorClient({
        apiKey: 'K',
        fetchImpl
    });
    await assert.rejects(() => c.verify({
        paymentRequirements: {},
        paymentPayload: {}
    }), /403/);
});

test('supported GETs /supported', async () => {
    const fetchImpl = mockFetch({
        kinds: [],
        signers: {}
    });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    const res = await c.supported();
    assert.deepEqual(res, {
        kinds: [],
        signers: {}
    });
    assert.equal(fetchImpl.calls[0].opts.method, 'GET');
});
