/**
 * Tests for the Express adapter: 402 on no payment, next()+req.x402 on paid,
 * 402 on invalid, and the per-route price → accepts mapping. A mock facilitator is
 * injected (no network). `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentMiddleware } from '../src/express.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** A minimal Express res double capturing status/json/set. */
function mockRes() {
    return {
        _status: null,
        _json: null,
        _headers: {},
        status(s) { this._status = s; return this; },
        json(b) { this._json = b; return this; },
        set(k, v) { this._headers[k] = v; return this; },
    };
}

/**
 *
 * @param payload
 */
function payHeader(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
const validPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
        signature: '0x',
        authorization: {}
    }
};

test('no payment → 402 with accepts body, next NOT called', async () => {
    const pay = paymentMiddleware({
        apiKey: 'K',
        payTo: '0xMerchant',
        facilitator: {}
    });
    const mw = pay({
        network: 'eip155:8453',
        asset: USDC,
        amount: '10000'
    });
    const res = mockRes();
    let nexted = false;
    await mw({
        headers: {},
        protocol: 'https',
        get: () => 'api.example.test',
        originalUrl: '/premium'
    }, res, () => { nexted = true; });
    assert.equal(res._status, 402);
    assert.equal(res._json.accepts[0].payTo, '0xMerchant');
    assert.equal(res._json.accepts[0].amount, '10000');
    assert.equal(nexted, false);
});

test('valid payment → settle → next() + req.x402 + X-PAYMENT-RESPONSE header', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: true,
            payer: '0xBuyer'
        }),
        settle: async () => ({
            success: true,
            payer: '0xBuyer',
            transaction: '0xtx',
            network: 'eip155:8453'
        }),
    };
    const pay = paymentMiddleware({
        apiKey: 'K',
        payTo: '0xMerchant',
        facilitator
    });
    const mw = pay({
        network: 'eip155:8453',
        asset: USDC,
        amount: '10000'
    });
    const req = {
        headers: { 'x-payment': payHeader(validPayload) },
        protocol: 'https',
        get: () => 'api.example.test',
        originalUrl: '/premium'
    };
    const res = mockRes();
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.x402.payer, '0xBuyer');
    assert.equal(req.x402.settlement.transaction, '0xtx');
    assert.ok(res._headers['x-payment-response']);
});

test('invalid payment → 402, next NOT called', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: false,
            invalidReason: 'expired'
        }),
        settle: async () => ({ success: true }),
    };
    const pay = paymentMiddleware({
        apiKey: 'K',
        payTo: '0xM',
        facilitator
    });
    const mw = pay({
        network: 'eip155:8453',
        asset: USDC,
        amount: '10000'
    });
    const res = mockRes();
    let nexted = false;
    await mw({
        headers: { 'x-payment': payHeader(validPayload) },
        protocol: 'https',
        get: () => 'api.example.test',
        originalUrl: '/premium'
    }, res, () => { nexted = true; });
    assert.equal(res._status, 402);
    assert.equal(res._json.error, 'expired');
    assert.equal(nexted, false);
});

test('per-route payTo overrides the default', async () => {
    const pay = paymentMiddleware({
        apiKey: 'K',
        payTo: '0xDefault',
        facilitator: {}
    });
    const mw = pay({
        network: 'eip155:8453',
        asset: USDC,
        amount: '5',
        payTo: '0xRouteSpecific'
    });
    const res = mockRes();
    await mw({
        headers: {},
        protocol: 'https',
        get: () => 'api.example.test',
        originalUrl: '/premium'
    }, res, () => {});
    assert.equal(res._json.accepts[0].payTo, '0xRouteSpecific');
});

test('a facilitator transport error → next(err) (502-class, not 402)', async () => {
    const facilitator = {
        verify: async () => { throw new Error('facilitator /verify failed: 503'); },
        settle: async () => ({}),
    };
    const pay = paymentMiddleware({
        apiKey: 'K',
        payTo: '0xM',
        facilitator
    });
    const mw = pay({
        network: 'eip155:8453',
        asset: USDC,
        amount: '10000'
    });
    const res = mockRes();
    let err;
    await mw({
        headers: { 'x-payment': payHeader(validPayload) },
        protocol: 'https',
        get: () => 'api.example.test',
        originalUrl: '/premium'
    }, res, (e) => { err = e; });
    assert.ok(err instanceof Error);
    assert.match(err.message, /facilitator/);
    assert.equal(res._status, null); // did not send a 402
});
