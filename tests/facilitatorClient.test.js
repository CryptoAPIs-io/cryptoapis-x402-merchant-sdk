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
    // PUBLIC endpoint: sending a key here would stop a merchant checking whether we
    // serve their chain BEFORE they sign up.
    assert.equal(fetchImpl.calls[0].opts.headers, undefined);
});

test('supported surfaces the spec-required extensions array', async () => {
    const fetchImpl = mockFetch({
        kinds: [],
        extensions: ['payment-identifier'],
        signers: { 'eip155:*': ['0xGAS']}
    });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    const res = await c.supported();
    assert.deepEqual(res.extensions, ['payment-identifier']);
    // signers are keyed by CAIP-2 NAMESPACE pattern, not concrete network.
    assert.ok(res.signers['eip155:*']);
});

test('discovery GETs the Bazaar catalogue with no api key', async () => {
    const fetchImpl = mockFetch({
        x402Version: 2,
        items: [],
        pagination: {
            limit: 20,
            offset: 0,
            total: 0
        }
    });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    const res = await c.discovery();
    assert.equal(res.x402Version, 2);
    assert.equal(fetchImpl.calls[0].url, 'https://fac/x402/merchant/discovery/resources');
    assert.equal(fetchImpl.calls[0].opts.headers, undefined);
});

test('discovery passes paging + type through as query params', async () => {
    const fetchImpl = mockFetch({
        x402Version: 2,
        items: [],
        pagination: {}
    });
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    await c.discovery({
        type: 'http',
        limit: 5,
        offset: 10
    });
    assert.equal(
        fetchImpl.calls[0].url,
        'https://fac/x402/merchant/discovery/resources?type=http&limit=5&offset=10'
    );
});

test('discovery throws on a non-2xx', async () => {
    const fetchImpl = mockFetch({}, 503);
    const c = createFacilitatorClient({
        apiKey: 'K',
        baseUrl: 'https://fac/x402/merchant',
        fetchImpl
    });
    await assert.rejects(() => c.discovery(), /discovery\/resources failed: 503/);
});
