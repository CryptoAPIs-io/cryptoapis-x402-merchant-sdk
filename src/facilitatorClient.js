/**
 * HTTP client to the CryptoAPIs x402 facilitator (`ai.cryptoapis.io/x402/merchant/*`).
 *
 * The merchant calls `/verify` (does this payment authorize exactly the required
 * payment?) then `/settle` (submit it on-chain). Both take `{ paymentRequirements,
 * paymentPayload }` and require the merchant's CryptoAPIs `x-api-key` (with the
 * X402_FACILITATOR feature). Protocol failures are HTTP 200 with `isValid/success:
 * false` bodies — a non-2xx is a transport/auth error, surfaced as a thrown Error.
 */

/** The production facilitator base URL (merchant-facing). @type {string} */
const DEFAULT_BASE_URL = 'https://ai.cryptoapis.io/x402/merchant';

/**
 * Create a facilitator client bound to a merchant API key.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the merchant's CryptoAPIs API key (X402_FACILITATOR feature)
 * @param {string} [params.baseUrl] override the facilitator base URL (e.g. QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (injectable for tests)
 * @return {{verify: Function, settle: Function, supported: Function}} the client
 */
function createFacilitatorClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl } = {}) {
    if (!apiKey) {
        throw new Error('createFacilitatorClient: apiKey is required');
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    const root = baseUrl.replace(/\/$/, '');

    /**
     * POST a JSON body to a facilitator path with auth, returning the parsed body.
     *
     * @param {string} path the path (e.g. `/verify`)
     * @param {Object} body the JSON request body
     * @return {Promise<Object>} the parsed response body
     * @throws {Error} on a non-2xx (transport/auth) response
     */
    async function post(path, body) {
        const res = await doFetch(`${root}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`facilitator ${path} failed: ${res.status} ${text}`.trim());
        }
        return res.json();
    }

    return {
        /**
         * Verify a payment authorizes exactly the stated requirements (no settlement).
         *
         * @param {Object} params the request
         * @param {Object} params.paymentRequirements the seller's stated terms
         * @param {Object} params.paymentPayload the buyer's signed payment
         * @return {Promise<{isValid: boolean, payer?: string, invalidReason?: string}>} the verify result
         */
        verify({ paymentRequirements, paymentPayload }) {
            return post('/verify', {
                paymentRequirements: paymentRequirements,
                paymentPayload: paymentPayload
            });
        },
        /**
         * Settle a verified payment on-chain (the facilitator signs + broadcasts).
         *
         * @param {Object} params the request
         * @param {Object} params.paymentRequirements the seller's stated terms
         * @param {Object} params.paymentPayload the buyer's signed payment
         * @return {Promise<{success: boolean, payer?: string, transaction?: string, network?: string, errorReason?: string}>} the settle result
         */
        settle({ paymentRequirements, paymentPayload }) {
            return post('/settle', {
                paymentRequirements: paymentRequirements,
                paymentPayload: paymentPayload
            });
        },
        /**
         * Discover the facilitator's supported {x402Version, scheme, network} kinds + signers.
         *
         * @return {Promise<{kinds: Array<Object>, signers: Object}>} the /supported body
         */
        async supported() {
            const res = await doFetch(`${root}/supported`, {
                method: 'GET',
                headers: { 'x-api-key': apiKey },
            });
            if (!res.ok) {
                throw new Error(`facilitator /supported failed: ${res.status}`);
            }
            return res.json();
        },
    };
}

export {
    createFacilitatorClient, DEFAULT_BASE_URL
};
