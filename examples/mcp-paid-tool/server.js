/**
 * A complete, runnable MCP server with ONE paid tool.
 *
 * This is the merchant side of x402 over MCP: an AI agent calls your tool, gets a price,
 * pays it, and only then receives the result. Copy this file, replace `analyse()` with your
 * real work, set the two env vars, and you are charging agents.
 *
 * Run:
 *   npm install
 *   CRYPTOAPIS_API_KEY=… X402_PAY_TO=0xYourAddress node server.js
 *
 * Then point any MCP client at it over stdio. To pay it from an agent, use the buyer half —
 * `@cryptoapis-io/x402-buyer-sdk/mcp` (`createX402ToolCaller`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { paymentTool } from '@cryptoapis-io/x402-merchant-sdk/mcp';
import { z } from 'zod';

// --- what you are selling -------------------------------------------------------------
// USDC on Base. `amount` is in ATOMIC units: USDC has 6 decimals, so 10000 = $0.01.
// Getting this wrong by 10^6 is the single easiest mistake to make here.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE = {
    network: 'eip155:8453',
    asset: USDC_BASE,
    amount: '10000',
};

// --- your actual work -----------------------------------------------------------------
/**
 * Replace this with whatever you are charging for.
 *
 * @param {string} ticker the requested symbol
 * @return {string} the analysis
 */
function analyse(ticker) {
    return `Deep analysis for ${ticker}: strong fundamentals, positive outlook.`;
}

// --- wire the paywall -----------------------------------------------------------------
const apiKey = process.env.CRYPTOAPIS_API_KEY;
const payTo = process.env.X402_PAY_TO;
if (!apiKey || !payTo) {
    // Fail at boot, not on the first paid call — a server that starts and then cannot
    // settle looks like a payment bug to every agent that tries it.
    console.error('Set CRYPTOAPIS_API_KEY (with the X402_FACILITATOR feature) and X402_PAY_TO.');
    process.exit(1);
}

const pay = paymentTool({
    apiKey: apiKey,
    payTo: payTo,
    // settle: false would verify without moving funds — advisory only, rarely what you want.
});

const server = new McpServer({
    name: 'paid-analysis',
    version: '1.0.0'
});

server.registerTool(
    'financial_analysis',
    {
        // The agent reads this to decide whether to call you — and whether the price is worth
        // it. State the cost here: an agent that discovers the price only by being refused
        // has already wasted a round-trip.
        description: 'Deep financial analysis for a ticker. Costs $0.01 USDC (Base) per call.',
        inputSchema: { ticker: z.string().describe('Ticker symbol, e.g. AAPL') },
    },
    // `pay(toolName, price, handler)` wraps the handler you would have written anyway.
    // The handler runs ONLY after payment has settled, so an unpaid or failed call never
    // reaches your code and you never do the work for free.
    pay('financial_analysis', PRICE, async ({ ticker }) => ({
        content: [{
            type: 'text',
            text: analyse(ticker)
        }],
    }))
);

await server.connect(new StdioServerTransport());
