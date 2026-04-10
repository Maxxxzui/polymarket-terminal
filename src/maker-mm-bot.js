/**
 * maker-mm-bot.js — Maker Rebate MM dengan Telegram Interactive
 */

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

import { validateMakerMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { startMMDetector, stopMMDetector, checkCurrentMarket } from './services/mmDetector.js';
import { executeMakerRebateStrategy, getActiveMakerPositions, getMarketOdds as getExecutorMarketOdds } from './services/makerRebateExecutor.js';
import { mmFillWatcher } from './services/mmWsFillWatcher.js';

logger.interceptConsole();

// --- TAMBAHAN FITUR TELEGRAM ---
let lastUpdateId = null;
let lastPosCount = -1;

async function kirimNotifTelegram(pesan) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: pesan, parse_mode: 'Markdown' })
        });
    } catch (err) {
        logger.error("Gagal kirim tele: " + err.message);
    }
}

async function dengarkanTelegram() {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) return;

    try {
        const offsetParam = lastUpdateId !== null ? `?offset=${lastUpdateId + 1}` : `?offset=-1`;
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates${offsetParam}&timeout=5`);
        const data = await res.json();
        
        if (data.result && data.result.length > 0) {
            for (const update of data.result) {
                const isFirstCheck = (lastUpdateId === null);
                lastUpdateId = update.update_id;

                if (isFirstCheck) {
                    logger.info("🧹 Membersihkan antrean perintah lama...");
                    continue;
                }

                const msg = update.message?.text;
                if (msg === '/status') {
                    logger.info("📩 Perintah Telegram: /status");
                    await printStatus(true);
                } 
                else if (msg === '/stop') {
                    logger.info("📩 Perintah Telegram: /stop");
                    await kirimNotifTelegram("🛑 *Maker-MM Bot Berhenti via Telegram!*");
                    setTimeout(() => process.exit(0), 500);
                }
            }
        } else if (lastUpdateId === null) {
            lastUpdateId = 0;
        }
    } catch (err) { /* silent error */ }
}
// -------------------------------

// ── Validate config ────────────────────────────────────────────────────────────
try {
    validateMakerMMConfig();
} catch (err) {
    logger.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init CLOB client ──────────────────────────────────────────────────────────
try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

mmFillWatcher.start();

config.mmAssets = config.makerMmAssets;
config.mmDuration = config.makerMmDuration;
config.mmPollInterval = config.makerMmPollInterval;
config.mmEntryWindow = config.makerMmEntryWindow;

// ── Periodic status log & Telegram Update ──────────────────────────────────────
async function printStatus(forceNotify = false) {
    try {
        let balanceValue = 0;
        let balanceStr = 'SIM';
        if (!config.dryRun) {
            try { 
                const b = await getUsdcBalance();
                balanceValue = b;
                balanceStr = `$${b.toFixed(2)} USDC`; 
            } catch { balanceStr = 'N/A'; }
        }

        const positions = getActiveMakerPositions();
        const mode = config.dryRun ? 'SIMULATION' : 'LIVE';

        logger.info(`--- MakerMM Status [${mode}] | Balance: ${balanceStr} | Active positions: ${positions.length} ---`);

        // Siapkan pesan Telegram
        let teleMsg = `🏗️ *Polymarket MakerMM [${mode}]*\n\n`;
        teleMsg += `💵 *Balance:* ${balanceStr}\n`;
        teleMsg += `📦 *Active Positions:* ${positions.length}\n\n`;

        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 45);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60 ? `${Math.floor(secsLeft / 60)}m` : `${secsLeft}s`;

            const yFill = pos.yes.filled ? `✅` : `$${pos.yes.buyPrice?.toFixed(3)}`;
            const nFill = pos.no.filled ? `✅` : `$${pos.no.buyPrice?.toFixed(3)}`;
            const combined = (pos.yes.buyPrice + pos.no.buyPrice).toFixed(4);

            logger.info(`  ${assetTag}${label} | ${pos.status} | YES ${yFill} | NO ${nFill}`);
            
            teleMsg += `🎯 ${assetTag}${label}\n`;
            teleMsg += `   ⏱️ ${timeStr} | 💰 Comb: $${combined}\n`;
            teleMsg += `   Y: ${yFill} | N: ${nFill}\n\n`;
        }

        if (positions.length === 0) teleMsg += `_Menunggu market yang sesuai..._\n`;

        // Kirim notif jika ada perubahan jumlah posisi atau dipaksa /status
        if (positions.length !== lastPosCount || forceNotify) {
            await kirimNotifTelegram(teleMsg);
            lastPosCount = positions.length;
        }
    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Market handler with per-asset queue ──────────────────────────────────────
const pendingByAsset = new Map();
const runningByAsset = new Set(); 

async function isCurrentMarketOddsValidForReentry(yesTokenId, noTokenId) {
    if (!config.currentMarketEnabled) return false;
    try {
        const odds = await getExecutorMarketOdds(yesTokenId, noTokenId);
        if (!odds) return false;
        return odds.max <= config.currentMarketMaxOdds;
    } catch (err) { return false; }
}

async function runStrategy(market) {
    const isCurrentMarket = market.isCurrentMarket ?? false;
    const assetTag = market.asset?.toUpperCase() || '';
    let cycleCount = 0;
    runningByAsset.add(market.asset);

    while (true) {
        cycleCount++;
        const maxWaitMs = 120_000;
        const waitStart = Date.now();

        while (true) {
            const activePositions = getActiveMakerPositions();
            const hasActivePosition = activePositions.some(p => p.asset === market.asset);
            if (!hasActivePosition) break;
            if (Date.now() - waitStart > maxWaitMs) return;
            await new Promise(r => setTimeout(r, 2000));
        }

        let cycleResult = { oneSided: false };
        try {
            cycleResult = await executeMakerRebateStrategy(market) ?? { oneSided: false };
        } catch (err) { logger.error(`MakerMM error (${assetTag}): ${err.message}`); }

        if (cycleResult.oneSided) break;

        const msRemaining = new Date(market.endTime).getTime() - Date.now();
        const secsLeft = Math.round(msRemaining / 1000);
        if (config.makerMmReentryEnabled && secsLeft > config.makerMmCutLossTime + 180) {
            if (isCurrentMarket && config.currentMarketEnabled) {
                const oddsValid = await isCurrentMarketOddsValidForReentry(market.yesTokenId, market.noTokenId);
                if (!oddsValid) break;
            }
            await new Promise(r => setTimeout(r, config.makerMmReentryDelay));
            continue; 
        }
        break;
    }

    runningByAsset.delete(market.asset);
    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);
        runStrategy(queued);
    }
}

async function handleNewMarket(market) {
    if (runningByAsset.has(market.asset)) {
        pendingByAsset.set(market.asset, market);
        return;
    }
    runStrategy(market);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const mode = config.dryRun ? 'SIMULATION' : 'LIVE';
logger.info(`=== Maker Rebate MM [${mode}] ===`);

await checkCurrentMarket((market) => handleNewMarket({ ...market, isCurrentMarket: true }));
startMMDetector(handleNewMarket);

// Notif Awal & Interval
await printStatus(true);
setInterval(printStatus, 60_000);
setInterval(dengarkanTelegram, 5000);

function shutdown() {
    logger.warn('MakerMM: shutting down...');
    stopMMDetector();
    mmFillWatcher.stop();
    setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
