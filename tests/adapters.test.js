/**
 * Tests for the Hono + Next.js adapters — both are thin wrappers over runPaymentGate
 * (already tested); these assert the framework translation: 402 body, paid → next()/
 * handler + X-PAYMENT-RESPONSE header, and the x402 context injection. Mocked
 * facilitator. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentMiddleware as honoPay } from '../src/hono.js';
import { withX402 } from '../src/next.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const price = {
    network: 'eip155:8453',
    asset: USDC,
    amount: '10000'
};

function payHeader() {
    const p = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
            signature: '0x',
            authorization: {}
        }
    };
    return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

const okFacilitator = {
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

/* ---------------------------------- Hono ---------------------------------- */

/** A minimal Hono context double. */
function honoCtx(paymentHeaderValue) {
    const store = {};
    return {
        _headers: {},
        _json: null,
        _status: null,
        req: {
            header: (name) => (name === 'x-payment' ? paymentHeaderValue : undefined),
            // the adapter derives the REQUIRED PaymentRequired.resource from the live request
            url: 'https://api.example.test/premium'
        },
        header(k, v) { this._headers[k] = v; },
        set(k, v) { store[k] = v; },
        get(k) { return store[k]; },
        json(body, status) {
            this._json = body; this._status = status; return {
                body,
                status
            };
        },
    };
}

test('hono: no payment → 402 body, next NOT called', async () => {
    const pay = honoPay({
        apiKey: 'K',
        payTo: '0xM',
        facilitator: {}
    });
    const mw = pay(price);
    const c = honoCtx(undefined);
    let nexted = false;
    await mw(c, async () => { nexted = true; });
    assert.equal(c._status, 402);
    assert.equal(c._json.accepts[0].amount, '10000');
    assert.equal(nexted, false);
});

test('hono: paid → next(), c.set(x402), X-PAYMENT-RESPONSE header', async () => {
    const pay = honoPay({
        apiKey: 'K',
        payTo: '0xM',
        facilitator: okFacilitator
    });
    const mw = pay(price);
    const c = honoCtx(payHeader());
    let nexted = false;
    await mw(c, async () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(c.get('x402').payer, '0xBuyer');
    assert.ok(c._headers['x-payment-response']);
});

/* ---------------------------------- Next ---------------------------------- */

/** A Web Request double with a payment header (or none). */
function nextReq(paymentHeaderValue) {
    return {
        headers: { get: (name) => (name === 'x-payment' ? paymentHeaderValue : null) },
        url: 'https://api.example.test/premium'
    };
}

test('next: no payment → 402 Response (handler NOT called)', async () => {
    const pay = withX402({
        apiKey: 'K',
        payTo: '0xM',
        facilitator: {}
    });
    let called = false;
    const route = pay(price, async () => { called = true; return Response.json({ ok: true }); });
    const res = await route(nextReq(null));
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.accepts[0].amount, '10000');
    assert.equal(called, false);
});

test('next: paid → handler(req, x402) called + X-PAYMENT-RESPONSE header added', async () => {
    const pay = withX402({
        apiKey: 'K',
        payTo: '0xM',
        facilitator: okFacilitator
    });
    let gotX402;
    const route = pay(price, async (req, x402) => { gotX402 = x402; return Response.json({ data: 'paid' }); });
    const res = await route(nextReq(payHeader()));
    assert.equal(res.status, 200);
    assert.equal(gotX402.payer, '0xBuyer');
    assert.equal(gotX402.settlement.transaction, '0xtx');
    assert.ok(res.headers.get('x-payment-response'));
    assert.equal((await res.json()).data, 'paid');
});

test('next: invalid payment → 402 Response', async () => {
    const facilitator = {
        verify: async () => ({
            isValid: false,
            invalidReason: 'expired'
        }),
        settle: async () => ({})
    };
    const pay = withX402({
        apiKey: 'K',
        payTo: '0xM',
        facilitator
    });
    const route = pay(price, async () => Response.json({ ok: true }));
    const res = await route(nextReq(payHeader()));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, 'expired');
});
