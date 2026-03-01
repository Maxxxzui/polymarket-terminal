/**
 * sniper.js
 * Console-only entry point for the Orderbook Sniper bot.
 * Places tiny GTC BUY orders at a low price on both sides of 5-min markets.
 *
 * Run with: npm run sniper       (live, console)
 *           npm run sniper-sim   (simulation, console)
 *
 * For the TUI dashboard version, use: npm run sniper-tui
 */

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { executeSnipe } from './services/sniperExecutor.js';
import { redeemSniperPositions } from './services/ctf.js';
import { getSchedule, isAssetInSession, getNextSessionInfo } from './services/schedule.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

if (config.sniperAssets.length === 0) {
    console.error('SNIPER_ASSETS is empty. Set e.g. SNIPER_ASSETS=eth,sol,xrp in .env');
    process.exit(1);
}

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Log session schedule ──────────────────────────────────────────────────────

function logSchedule() {
    const schedule = getSchedule();
    logger.info('─── Session Schedule (UTC+8) ───');
    for (const asset of config.sniperAssets) {
        const sessions = schedule[asset];
        const active = isAssetInSession(asset);
        const status = active ? '● ACTIVE' : '○ IDLE';
        if (sessions) {
            const sessionStr = sessions.map(s => `${s.startUtc8}–${s.endUtc8}`).join(', ');
            logger.info(`  ${asset.toUpperCase()} [${status}]  ${sessionStr}`);
            if (!active) {
                const next = getNextSessionInfo(asset);
                if (next) logger.info(`    → Next in ${next}`);
            }
        } else {
            logger.info(`  ${asset.toUpperCase()} [NO SCHEDULE] (always active)`);
        }
    }
    logger.info('────────────────────────────────');
}

// ── Redeemer ──────────────────────────────────────────────────────────────────

let redeemTimer = null;

function startRedeemer() {
    // Only run on interval, NOT on startup (we only want to redeem NEW winning positions)
    redeemTimer = setInterval(
        () => redeemSniperPositions().catch((err) => logger.error('Sniper redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`Sniper redeemer started — checking every ${config.redeemInterval / 1000}s (winners only, no startup check)`);
}

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
    executeSnipe(market).catch((err) =>
        logger.error(`SNIPER execute error (${market.asset}): ${err.message}`)
    );
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('SNIPER: shutting down...');
    stopSniperDetector();
    if (redeemTimer) clearInterval(redeemTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const costPerSlot = (config.sniperPrice * config.sniperShares * 2 * config.sniperAssets.length).toFixed(3);
logger.info(`SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Assets: ${config.sniperAssets.join(', ').toUpperCase()} | $${config.sniperPrice} × ${config.sniperShares}sh = $${costPerSlot}/slot`);

logSchedule();
startRedeemer();
startSniperDetector(handleNewMarket);
