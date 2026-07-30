/**
 * A2A transport adapter — asserts the WIRE SHAPE from specs/transports-v2/a2a.md.
 *
 * These pin the three things A2A does differently from http/mcp, each of which is silently wrong
 * if you assume the MCP shape: the task-state signalling, the LITERAL dotted metadata keys, and
 * the `accepted` wrapper on the payload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    paymentSkill, agentCardExtension, normalizePayload, readPaymentFromMessage,
    META, STATUS, TASK_STATE, EXTENSION_URI,
} from '../src/a2a.js';

const PRICE = {
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0x6198000000000000000000000000000000005A6e',
};
const RESOURCE = {
    url: 'https://api.example.com/generate-image',
    description: 'Generate an image',
    mimeType: 'image/png'
};

/** A facilitator stub whose verify/settle outcomes the test controls. */
function stubFacilitator({ isValid = true, success = true, invalidReason, errorReason } = {}) {
    return {
        verify: async () => ({
            isValid,
            payer: '0xpayer',
            ...(invalidReason ? { invalidReason } : {})
        }),
        settle: async () => ({
            success,
            payer: '0xpayer',
            transaction: success ? '0xtx' : '',
            network: PRICE.network,
            ...(errorReason ? { errorReason } : {}),
        }),
    };
}

/** A signed payload in the A2A wire form — the requirement echoed back under `accepted`. */
function a2aPayment() {
    return {
        x402Version: 2,
        resource: RESOURCE,
        accepted: {
            scheme: 'exact',
            network: PRICE.network,
            amount: PRICE.amount,
            asset: PRICE.asset,
            payTo: PRICE.payTo
        },
        payload: {
            signature: '0xsig',
            authorization: {
                from: '0xpayer',
                to: PRICE.payTo,
                value: PRICE.amount
            }
        },
    };
}

test('unpaid call → task state input-required with the PaymentRequired body', async () => {
    const pay = paymentSkill({ facilitator: stubFacilitator() });
    const skill = pay(RESOURCE, PRICE, async () => ({ artifacts: []}));

    const out = await skill({ message: { parts: []} });

    assert.equal(out.status.state, TASK_STATE.INPUT_REQUIRED, 'A2A signals payment via task state, not a status code');
    const meta = out.status.message.metadata;
    assert.equal(meta[META.STATUS], STATUS.REQUIRED);

    const body = meta[META.REQUIRED];
    assert.equal(body.x402Version, 2);
    assert.equal(body.resource.url, RESOURCE.url, 'resource is REQUIRED by x402 v2 §5.1.2');
    assert.equal(body.resource.mimeType, 'image/png', 'the full ResourceInfo is carried through');
    assert.equal(body.accepts[0].network, PRICE.network);
    assert.equal(body.accepts[0].amount, PRICE.amount);
});

test('metadata keys are LITERAL dotted strings, not nested objects', async () => {
    const pay = paymentSkill({ facilitator: stubFacilitator() });
    const skill = pay(RESOURCE, PRICE, async () => ({}));
    const out = await skill({});

    const meta = out.status.message.metadata;
    // The trap: building {x402:{payment:{required}}} yields a shape no A2A client reads.
    assert.ok(Object.hasOwn(meta, 'x402.payment.required'), 'the key itself contains dots');
    assert.equal(meta.x402, undefined, 'must NOT be nested under an `x402` object');
});

test('the handler runs ONLY after settlement, and the task completes with a receipt ARRAY', async () => {
    let ran = 0;
    const pay = paymentSkill({ facilitator: stubFacilitator() });
    const skill = pay(RESOURCE, PRICE, async () => {
        ran++; return {
            artifacts: [{
                kind: 'image',
                name: 'out.png'
            }]
        };
    });

    const unpaid = await skill({});
    assert.equal(ran, 0, 'an unpaid call never reaches the handler — the merchant does no free work');

    const paid = await skill({ message: { metadata: { [META.PAYLOAD]: a2aPayment() } } });
    assert.equal(ran, 1);
    assert.equal(paid.status.state, TASK_STATE.COMPLETED);
    assert.equal(paid.status.message.metadata[META.STATUS], STATUS.COMPLETED);

    const receipts = paid.status.message.metadata[META.RECEIPTS];
    assert.ok(Array.isArray(receipts), 'receipts is an ARRAY — a task may accrue several payments');
    assert.equal(receipts[0].success, true);
    assert.equal(receipts[0].transaction, '0xtx');
    assert.deepEqual(paid.artifacts, [{
        kind: 'image',
        name: 'out.png'
    }], "the skill's own result survives");
    assert.equal(unpaid.artifacts, undefined);
});

test('a rejected payment is TERMINAL failed, never another ask', async () => {
    const pay = paymentSkill({
        facilitator: stubFacilitator({
            isValid: false,
            invalidReason: 'invalid_signature'
        })
    });
    const skill = pay(RESOURCE, PRICE, async () => ({ artifacts: []}));

    const out = await skill({ message: { metadata: { [META.PAYLOAD]: a2aPayment() } } });

    assert.equal(out.status.state, TASK_STATE.FAILED, 're-asking would loop a client that already paid');
    const meta = out.status.message.metadata;
    assert.equal(meta[META.STATUS], STATUS.FAILED);
    assert.equal(meta[META.ERROR], 'invalid_signature', 'the spec §9 code is surfaced');
    assert.equal(meta[META.RECEIPTS][0].success, false);
    assert.equal(meta[META.RECEIPTS][0].transaction, '', 'transaction is "" on failure, never absent (§5.3.2)');
});

test('a settle failure also fails the task', async () => {
    const pay = paymentSkill({
        facilitator: stubFacilitator({
            success: false,
            errorReason: 'invalid_transaction_state'
        })
    });
    const skill = pay(RESOURCE, PRICE, async () => ({ artifacts: []}));

    const out = await skill({ message: { metadata: { [META.PAYLOAD]: a2aPayment() } } });
    assert.equal(out.status.state, TASK_STATE.FAILED);
    assert.equal(out.status.message.metadata[META.ERROR], 'invalid_transaction_state');
});

test('normalizePayload lifts scheme/network out of the A2A `accepted` wrapper', () => {
    const lifted = normalizePayload(a2aPayment());
    assert.equal(lifted.scheme, 'exact', 'the gate pairs by network, so it must see it at the top');
    assert.equal(lifted.network, PRICE.network);
    assert.deepEqual(lifted.accepted, a2aPayment().accepted, 'the original wrapper is preserved for the facilitator');

    // The flat HTTP/MCP form must pass through untouched.
    const flat = {
        scheme: 'exact',
        network: 'eip155:1',
        payload: {}
    };
    assert.deepEqual(normalizePayload(flat), flat);
    assert.equal(normalizePayload(null), null);
});

test('the payment is found on the message, on bare metadata, or on params', () => {
    const p = a2aPayment();
    assert.deepEqual(readPaymentFromMessage({ message: { metadata: { [META.PAYLOAD]: p } } }), p);
    assert.deepEqual(readPaymentFromMessage({ metadata: { [META.PAYLOAD]: p } }), p);
    assert.deepEqual(readPaymentFromMessage({ [META.PAYLOAD]: p }), p);
    assert.equal(readPaymentFromMessage(undefined), null);
    assert.equal(readPaymentFromMessage({ metadata: {} }), null);
});

test('agentCardExtension emits the declaration an AgentCard must publish', () => {
    const ext = agentCardExtension();
    assert.equal(ext.uri, EXTENSION_URI);
    assert.equal(ext.required, true, 'a paid agent is unusable to a client that cannot pay');
    assert.equal(agentCardExtension(false).required, false);
});

test('a resource given as a bare url string still satisfies §5.1.2', async () => {
    const pay = paymentSkill({ facilitator: stubFacilitator() });
    const skill = pay('https://api.example.com/thing', PRICE, async () => ({}));
    const out = await skill({});
    assert.equal(out.status.message.metadata[META.REQUIRED].resource.url, 'https://api.example.com/thing');
});

test('several prices become several accepts entries', async () => {
    const pay = paymentSkill({ facilitator: stubFacilitator() });
    const skill = pay(RESOURCE, [PRICE, {
        ...PRICE,
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    }], async () => ({}));
    const out = await skill({});
    const accepts = out.status.message.metadata[META.REQUIRED].accepts;
    assert.equal(accepts.length, 2);
    assert.equal(accepts[1].network, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
});
