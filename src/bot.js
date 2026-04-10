/**
 * bot.js — PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 * pm2 start ecosystem.config.cjs
 * pm2 logs polymarket-copy
 */
import config, { validateConfig } from './config/index.js';
import { initClient, getUsdcBalance, getClient } from './services/client.js';
import { executeBuy, executeSell } from './services/executor.js';
import { checkAndRedeemPositions } from './services/redeemer.js';
import { getOpenPositions } from './services/position.js';
import { startWsWatcher, stopWsWatcher } from './services/wsWatcher.js';
import { getSimStats } from './utils/simStats.js';
import logger from './utils/logger.js';

logger.interceptConsole(); // strip auth headers from CLOB axios error dumps

// --- TAMBAHAN FUNGSI TELEGRAM INTERACTIVE (FIXED) ---
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
        // Trik offset=-1 untuk membersihkan antrean chat lama saat bot baru nyala
        const offsetParam = lastUpdateId !== null ? `?offset=${lastUpdateId + 1}` : `?offset=-1`;
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates${offsetParam}&timeout=5`);
        const data = await res.json();
        
        if (data.result && data.result.length > 0) {
            for (const update of data.result) {
                const isFirstCheck = (lastUpdateId === null);
                lastUpdateId = update.update_id;

                // Jika ini cek pertama, abaikan pesan lama (biar gak mati sendiri)
                if (isFirstCheck) {
                    logger.info("🧹 Membersihkan antrean perintah lama dari Telegram...");
                    continue;
                }

                const msg = update.message?.text;
                if (!msg) continue;
                
                if (msg === '/status') {
                    logger.info("📩 Perintah Telegram: /status");
                    await printStatus(true);
                } 
                else if (msg === '/stop') {
                    logger.info("📩 Perintah Telegram: /stop");
                    await kirimNotifTelegram("🛑 *Bot dihentikan via Telegram!*");
                    setTimeout(() => process.exit(0), 500);
                }
                else if (msg === '/start') {
                    await kirimNotifTelegram("🤖 *Bot Polymarket aktif!* \nKetik /status untuk cek saldo & posisi.");
                }
            }
        } else if (lastUpdateId === null) {
            // Jika tidak ada update sama sekali saat start, set ID ke 0 agar loop berikutnya normal
            lastUpdateId = 0;
        }
    } catch (err) { /* silent error */ }
}
// --------------------------------------------

// ── Handle a trade event from WebSocket ───────────────────────────────────────
async function handleTrade(trade) {
    try {
        if (trade.type === 'BUY')  await executeBuy(trade);
        if (trade.type === 'SELL') await executeSell(trade);
    } catch (err) {
        logger.error(`Error processing trade ${trade.id}: ${err.message}`);
    }
}

// ── Periodic status log & Telegram Notif ──────────────────────────────────────
async function printStatus(forceNotify = false) {
    try {
        const balance   = await getUsdcBalance();
        const positions = getOpenPositions();

        logger.info(`--- Status | Balance: $${balance.toFixed(2)} USDC | Open positions: ${positions.length} ---`);

        let teleMsg = `🤖 *Polymarket Status Update*\n\n`;
        teleMsg += `💵 *Total Balance:* $${balance.toFixed(2)} USDC\n`;
        teleMsg += `📦 *Open Positions:* ${positions.length}\n\n`;
        let hasPositions = false;

        for (const pos of positions) {
            let pnlStr = '';
            let telePnlStr = '';
            try {
                const client = getClient();
                const mp = await client.getMidpoint(pos.tokenId);
                const mid = parseFloat(mp?.mid ?? mp ?? '0');
                if (mid > 0) {
                    const pnl  = (mid - pos.avgBuyPrice) * pos.shares;
                    const sign = pnl >= 0 ? '+' : '';
                    const pct  = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : '0.0';
                    pnlStr = ` | unrealized ${sign}$${pnl.toFixed(2)} (${sign}${pct}%)`;
                    telePnlStr = `\n   📈 *PnL:* ${sign}$${pnl.toFixed(2)} (${sign}${pct}%)`;
                }
            } catch { /* price unavailable */ }

            const name = (pos.market || pos.tokenId || '').substring(0, 50);
            logger.info(`  [${pos.outcome || '?'}] ${name} | ${pos.shares.toFixed(4)} sh @ $${pos.avgBuyPrice.toFixed(4)} | spent $${(pos.totalCost || 0).toFixed(2)}${pnlStr}`);

            teleMsg += `🎯 *[${pos.outcome || '?'}]* ${name}\n`;
            teleMsg += `   📊 ${pos.shares.toFixed(2)} sh @ $${pos.avgBuyPrice.toFixed(4)}${telePnlStr}\n\n`;
            hasPositions = true;
        }

        if (!hasPositions) teleMsg += `_Tidak ada posisi terbuka._\n`;

        if (config.dryRun) {
            const s = getSimStats();
            if (s.totalBuys > 0 || s.totalResolved > 0) {
                teleMsg += `\n🧪 *SIMULATION STATS*\n`;
                teleMsg += `Buys: ${s.totalBuys} | Wins: ${s.wins} | PnL: $${(s.closedPnl || 0).toFixed(2)}\n`;
            }
        }

        if (positions.length !== lastPosCount || forceNotify) {
            await kirimNotifTelegram(teleMsg);
            lastPosCount = positions.length;
        }

    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    try {
        validateConfig();
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }

    const mode = config.dryRun ? 'SIMULATION' : 'LIVE TRADING';
    logger.info(`=== Polymarket Copy Trade [${mode}] ===`);
    
    try { await initClient(); } catch (err) {
        logger.error('Failed to initialize CLOB client:', err.message);
        process.exit(1);
    }

    startWsWatcher(handleTrade);
    await redeemerLoop();
    setInterval(redeemerLoop, config.redeemInterval);

    // Kirim notif pertama
    await printStatus(true);
    setInterval(printStatus, 60_000);

    // Jalankan pendengar Telegram (cek tiap 5 detik)
    setInterval(dengarkanTelegram, 5000);

    const shutdown = () => {
        logger.info('Shutting down...');
        stopWsWatcher();
        setTimeout(() => process.exit(0), 300);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

async function redeemerLoop() {
    try { await checkAndRedeemPositions(); } catch (err) { logger.error('Redeemer loop error:', err.message); }
}

main().catch((err) => {
    logger.error('Fatal error:', err.message);
    process.exit(1);
});
