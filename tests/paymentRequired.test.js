/**
 * `PaymentRequired.resource` is REQUIRED by x402 v2 §5.1.2, and `resource.url` is required
 * inside it. These assert we emit a conformant body and refuse to emit a broken one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    build402Body, buildPaymentRequirements
} from '../src/index.js';

const accepts = () => [buildPaymentRequirements({
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0xMerchant',
})];

test('emits the required resource object', () => {
    const body = build402Body({
        accepts: accepts(),
        resource: { url: 'https://api.example.test/premium' },
    });
    assert.equal(body.x402Version, 2);
    assert.equal(body.resource.url, 'https://api.example.test/premium');
    assert.ok(Array.isArray(body.accepts));
});

test('THROWS rather than emit a body without resource.url', () => {
    // Silently omitting a REQUIRED field is how a non-conformant response reaches a
    // client that then breaks on it — fail loudly at the source instead.
    assert.throws(() => build402Body({ accepts: accepts() }), /resource\.url is required/);
    assert.throws(() => build402Body({
        accepts: accepts(),
        resource: {}
    }), /resource\.url is required/);
    assert.throws(() => build402Body({
        accepts: accepts(),
        resource: { url: '' }
    }), /resource\.url is required/);
});

test('carries the optional ResourceInfo fields only when given', () => {
    const bare = build402Body({
        accepts: accepts(),
        resource: { url: 'u' }
    });
    assert.equal('description' in bare.resource, false);
    assert.equal('mimeType' in bare.resource, false);

    const full = build402Body({
        accepts: accepts(),
        resource: {
            url: 'u',
            description: 'Premium data',
            mimeType: 'application/json'
        },
    });
    assert.equal(full.resource.description, 'Premium data');
    assert.equal(full.resource.mimeType, 'application/json');
});

test('supports the optional extensions field (§5.1.2)', () => {
    const body = build402Body({
        accepts: accepts(),
        resource: { url: 'u' },
        extensions: { 'payment-identifier': { info: { required: false } } },
    });
    assert.ok(body.extensions['payment-identifier']);
    // omitted when not supplied, rather than emitted empty
    assert.equal('extensions' in build402Body({
        accepts: accepts(),
        resource: { url: 'u' }
    }), false);
});
