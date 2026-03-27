/**
 * patch-clob-client.cjs
 *
 * Patches @polymarket/clob-client to inject proxy support.
 * Runs automatically via `npm install` (postinstall hook).
 *
 * What it does:
 *   - Adds HttpsProxyAgent import to http-helpers/index.js
 *   - Injects proxy agent into every axios request to polymarket.com
 *   - Reads PROXY_URL from process.env at runtime
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
    __dirname,
    '..',
    'node_modules',
    '@polymarket',
    'clob-client',
    'dist',
    'http-helpers',
    'index.js',
);

if (!fs.existsSync(TARGET)) {
    console.log('[patch] @polymarket/clob-client not found — skipping');
    process.exit(0);
}

let code = fs.readFileSync(TARGET, 'utf8');

// Check if already patched
if (code.includes('getProxyAgent')) {
    console.log('[patch] @polymarket/clob-client already patched — skipping');
    process.exit(0);
}

// Find the line after the axios import to inject proxy code
const AXIOS_IMPORT = `require("axios")`;
if (!code.includes(AXIOS_IMPORT)) {
    console.error('[patch] Could not find axios import in http-helpers — skipping');
    process.exit(0);
}

// Inject proxy imports and helper after axios import line
const PROXY_CODE = `
// Proxy support for Polymarket API (auto-patched by scripts/patch-clob-client.cjs)
const https_proxy_agent_1 = require("https-proxy-agent");
const getProxyAgent = () => {
    if (process.env.PROXY_URL) {
        return new https_proxy_agent_1.HttpsProxyAgent(process.env.PROXY_URL);
    }
    return undefined;
};`;

// Insert after the browser_or_node require line
const INSERT_AFTER = `require("browser-or-node");`;
if (!code.includes(INSERT_AFTER)) {
    console.error('[patch] Could not find browser-or-node import — skipping');
    process.exit(0);
}

code = code.replace(INSERT_AFTER, INSERT_AFTER + PROXY_CODE);

// Patch the request function to inject proxy agent
const REQUEST_CONFIG = `const config = { method, url: endpoint, headers, data, params };`;
const PATCHED_CONFIG = `const config = { method, url: endpoint, headers, data, params };
    // Add proxy agent for Polymarket API
    if (endpoint && endpoint.includes('polymarket.com')) {
        const agent = getProxyAgent();
        if (agent) {
            config.httpsAgent = agent;
            config.proxy = false;
        }
    }`;

if (!code.includes(REQUEST_CONFIG)) {
    console.error('[patch] Could not find request config line — skipping');
    process.exit(0);
}

code = code.replace(REQUEST_CONFIG, PATCHED_CONFIG);

fs.writeFileSync(TARGET, code, 'utf8');
console.log('[patch] @polymarket/clob-client patched with proxy support ✅');
