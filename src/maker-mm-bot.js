/**
 * maker-mm-bot.js — Maker Rebate MM dengan Telegram Pro & Close Notif
 */

import './utils/proxy-patch.cjs';
import { validateMakerMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance, getClient } from './services/client.js';
import { startMMDetector, stopMMDetector, checkCurrentMarket } from './services/mmDetector.js';
import { executeMakerRebateStrategy, getActiveMakerPositions, getMarketOdds as getExecutorMarketOdds } from './services/makerRebateExecutor.js';
import { mmFillWatcher } from './services/mmWsFillWatcher.js';
import { getSimStats } from './utils/simStats.js';

logger.interceptConsole();

// --- TAMBAHAN FITUR TELEGRAM PRO ---
let lastUpdateId = null;
let lastPosCount = 0;

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
    } catch (err) { logger.error("Gagal kirim tele: " + err.message); }
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
                if (isFirstCheck) continue;
                const msg = update.message?.text;
                if (msg === '/status') { await printStatus(true); } 
                else if (msg === '/stop') {
                    await kirimNotifTelegram("🛑 *Maker-MM Bot Berhenti via Telegram!*");
                    setTimeout(() => process.exit(0), 500);
                }
            }
        } else if (lastUpdateId === null) { lastUpdateId = 0; }
    } catch (err) { }
}

async function printStatus(forceNotify = false) {
    try {
        const positions = getActiveMakerPositions();
        const currentPosCount = positions.length;

        // 1. Notif Close (Jika posisi berkurang)
        if (currentPosCount < lastPosCount) {
            await kirimNotifTelegram("🏁 *NOTIFIKASI CLOSE*\n\nPosisi telah diselesaikan atau ditarik. Menunggu market baru...");
        }

        let teleMsg = "";
        if (currentPosCount > 0) {
            for (const pos of positions) {
                const label = pos.question.substring(0, 50);
                const avgPrice = (pos.yes.buyPrice + pos.no.buyPrice) / 2;
                const totalSh = pos.targetShares || 0;

                // Format sesuai permintaan: 🎯 [TAG] Nama... (Spasi) 📊 Detail (Spasi) 📈 PnL
                teleMsg += `🎯 *[${pos.asset?.toUpperCase() || 'MM'}]* ${label}...\n\n`;
                teleMsg += `📊 ${totalSh.toFixed(2)} sh @ $${avgPrice.toFixed(4)}\n\n`;
                
                // Cari unrealized PnL sederhana jika mid price tersedia
                let pnlStr = "Waiting result...";
                try {
                    const client = getClient();
                    const mp = await client.getMidpoint(pos.yesTokenId);
                    const mid = parseFloat(mp?.mid ?? mp ?? '0');
                    if (mid > 0) {
                        const pnl = (mid - pos.yes.buyPrice) * totalSh;
                        const sign = pnl >= 0 ? '+' : '';
                        pnlStr = `${sign}$${pnl.toFixed(2)}`;
                    }
                } catch {}
                teleMsg += `📈 *PnL:* ${pnlStr}\n\n`;
            }
        } else if (forceNotify) {
            teleMsg += `ℹ️ *Status:* Tidak ada posisi aktif.\n\n`;
        }

        // 2. Tambahkan Stats Simulasi di bawah
        const s = getSimStats();
        teleMsg += `🧪 *SIMULATION STATS*\n`;
        teleMsg += `Buys: ${s.totalBuys || 0} | Wins: ${s.wins || 0} | PnL: $${(s.closedPnl || 0).toFixed(2)}\n`;

        // Kirim jika ada perubahan atau dipaksa /status
        if (currentPosCount !== lastPosCount || forceNotify) {
            if (teleMsg !== "") await kirimNotifTelegram(teleMsg);
            lastPosCount = currentPosCount;
        }
    } catch (err) { logger.warn(`Status error: ${err.message}`); }
}

// ── Logika Strategi & Lifecycle (Original) ───────────────────────────────────

try { validateMakerMMConfig(); } catch (err) { process.exit(1); }
try { await initClient(); } catch (err) { process.exit(1); }

mmFillWatcher.start();
config.mmAssets = config.makerMmAssets;
config.mmDuration = config.makerMmDuration;
config.mmPollInterval = config.makerMmPollInterval;
config.mmEntryWindow = config.makerMmEntryWindow;

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
    runningByAsset.add(market.asset);

    // Notif saat bid dimulai
    await kirimNotifTelegram(`🚀 *MARKET DETECTED*\n\n🎯 [${assetTag}] ${market.question.substring(0,60)}...\n\n_Bot sedang memasang antrean (Bid)..._`);

    while (true) {
        const waitStart = Date.now();
        while (getActiveMakerPositions().some(p => p.asset === market.asset)) {
            if (Date.now() - waitStart > 120_000) return;
            await new Promise(r => setTimeout(r, 2000));
        }

        try {
            await executeMakerRebateStrategy(market);
            await printStatus(); 
        } catch (err) { logger.error(`MM error: ${err.message}`); }
        break; 
    }
    runningByAsset.delete(market.asset);
}

async function handleNewMarket(market) {
    if (runningByAsset.has(market.asset)) {
        pendingByAsset.set(market.asset, market);
        return;
    }
    runStrategy(market);
}

// ── Main Start ───────────────────────────────────────────────────────────────

const mode = config.dryRun ? 'SIMULATION' : 'LIVE';
logger.info(`=== Maker Rebate MM [${mode}] ===`);

await checkCurrentMarket((m) => handleNewMarket({ ...m, isCurrentMarket: true }));
startMMDetector(handleNewMarket);

// Interval
await printStatus(true);
setInterval(printStatus, 60_000);
setInterval(dengarkanTelegram, 5000);

function shutdown() {
    stopMMDetector();
    mmFillWatcher.stop();
    setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
