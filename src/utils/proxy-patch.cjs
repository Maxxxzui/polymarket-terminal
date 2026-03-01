/**
 * proxy-patch.cjs
 *
 * Simple proxy patch using https-proxy-agent.
 * Only routes Polymarket domains through proxy.
 */

const PROXY_URL = process.env.PROXY_URL || '';

if (PROXY_URL) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const https = require('https');
    const http = require('http');

    const agent = new HttpsProxyAgent(PROXY_URL);

    // Polymarket domains
    const POLY_DOMAINS = [
        'polymarket.com',
        'clob.polymarket.com',
        'gamma-api.polymarket.com',
        'data-api.polymarket.com',
    ];

    function shouldProxy(hostname) {
        if (!hostname) return false;
        for (const domain of POLY_DOMAINS) {
            if (hostname === domain || hostname.endsWith('.' + domain)) {
                return true;
            }
        }
        return false;
    }

    // Store originals
    const originalHttpsRequest = https.request;
    const originalHttpRequest = http.request;

    // Patch https.request
    https.request = function(options, callback) {
        let hostname;

        if (typeof options === 'string') {
            try {
                const url = new URL(options);
                hostname = url.hostname;
            } catch {
                return originalHttpsRequest.apply(https, arguments);
            }
        } else {
            hostname = options.hostname || options.host;
            if (typeof hostname === 'string' && hostname.includes(':')) {
                hostname = hostname.split(':')[0];
            }
        }

        // Only proxy Polymarket
        if (!shouldProxy(hostname)) {
            return originalHttpsRequest.apply(https, arguments);
        }

        // Apply proxy agent
        if (typeof options === 'string') {
            // Convert string URL to options object with agent
            const url = new URL(options);
            const newOptions = {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {},
                agent: agent,
            };
            if (callback) {
                return originalHttpsRequest.call(https, newOptions, callback);
            }
            return originalHttpsRequest.call(https, newOptions);
        } else {
            // Options object - just add agent
            options.agent = agent;
            return originalHttpsRequest.apply(https, arguments);
        }
    };

    // Patch http.request (for HTTP proxy connections)
    http.request = function(options, callback) {
        let hostname;

        if (typeof options === 'string') {
            try {
                const url = new URL(options);
                hostname = url.hostname;
            } catch {
                return originalHttpRequest.apply(http, arguments);
            }
        } else {
            hostname = options.hostname || options.host;
        }

        // Only proxy Polymarket
        if (!shouldProxy(hostname)) {
            return originalHttpRequest.apply(http, arguments);
        }

        // Apply same logic for HTTP
        if (typeof options === 'string') {
            const url = new URL(options);
            const newOptions = {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {},
                agent: agent,
            };
            if (callback) {
                return originalHttpRequest.call(http, newOptions, callback);
            }
            return originalHttpRequest.call(http, newOptions);
        } else {
            options.agent = agent;
            return originalHttpRequest.apply(http, arguments);
        }
    };

    console.log('[proxy-patch] Proxy active for Polymarket domains');
}
