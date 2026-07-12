/**
 * CryptoAPIs x402 merchant SDK (`@cryptoapis/x402-merchant-sdk`) — monetize any API
 * per-request with x402 via the CryptoAPIs facilitator.
 *
 * Framework-agnostic core (this module) + framework adapters
 * (`@cryptoapis/x402-merchant-sdk/express`). The core:
 *   - `createFacilitatorClient` — call /verify + /settle with the merchant api-key
 *   - `buildPaymentRequirements` / `build402Body` — the 402 the merchant returns
 *   - `runPaymentGate` — the transport-agnostic decide (payment-required / paid / invalid)
 *
 * Non-custodial: the SDK never holds keys or signs. The buyer signs locally; the
 * facilitator's gas wallet settles. The merchant only states a price + relays.
 */

export {
    createFacilitatorClient, DEFAULT_BASE_URL
} from './facilitatorClient.js';
export {
    buildPaymentRequirements, build402Body, SCHEME_EXACT
} from './paymentRequirements.js';
export {
    runPaymentGate,
    decodePaymentHeader,
    encodePaymentResponse,
    PAYMENT_HEADER,
    PAYMENT_RESPONSE_HEADER,
} from './paymentGate.js';
