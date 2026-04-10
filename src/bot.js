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

// --- TAMBAHAN FUNGSI TELEGRAM PRO ---
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

// Variabel untuk melacak perubahan posisi
let lastPosCount = -1;
// ------------------------------------

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
async function printStatus() {
    try {
        const balance   = await getUsdcBalance();
        const positions = getOpenPositions();

        // 1. Catat ke terminal (bawaan asli)
        logger.info(`--- Status | Balance: $${balance.toFixed(2)} USDC | Open positions: ${positions.length} ---`);

        // 2. Siapkan kerangka pesan Telegram
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
            
            // Tulis di Terminal
            logger.info(
                `  [${pos.outcome || '?'}] ${name}` +
                ` | ${pos.shares.toFixed(4)} sh @ $${pos.avgBuyPrice.toFixed(4)}` +
                ` | spent $${(pos.totalCost || 0).toFixed(2)}${pnlStr}`,
            );

            // Tambahkan ke pesan Telegram
            teleMsg += `🎯 *[${pos.outcome || '?'}]* ${name}\n`;
            teleMsg += `   📊 ${pos.shares.toFixed(2)} sh @ $${pos.avgBuyPrice.toFixed(4)}${telePnlStr}\n\n`;
            hasPositions = true;
        }

        if (!hasPositions) {
            teleMsg += `_Tidak ada posisi terbuka._\n`;
        }

        if (config.dryRun) {
            const s = getSimStats();
            if (s.totalBuys > 0 || s.totalResolved > 0) {
                const rate = s.totalResolved > 0
                    ? `${((s.wins / s.totalResolved) * 100).toFixed(0)}% win`
                    : 'no resolved yet';
                logger.info(
                    `  [SIM] ${s.totalBuys} buys tracked | ${s.wins}W/${s.losses}L (${rate})` +
                    ` | realized P&L: $${(s.closedPnl || 0).toFixed(2)}`,
                );
                
                // Tambahkan stat simulasi ke Telegram
                teleMsg += `\n🧪 *SIMULATION STATS*\n`;
                teleMsg += `Buys: ${s.totalBuys} | Wins: ${s.wins} | PnL: $${(s.closedPnl || 0).toFixed(2)}\n`;
            }
        }

        // --- 3. LOGIKA PENGIRIMAN TELEGRAM ---
        // Kirim ke Telegram HANYA saat baru jalan atau ada perubahan jumlah open posisi
        if (positions.length !== lastPosCount) {
            await kirimNotifTelegram(teleMsg);
            lastPosCount = positions.length; // Perbarui tracker
        }

    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Redeemer loop ─────────────────────────────────────────────────────────────
async function redeemerLoop() {
    try {
        await checkAndRedeemPositions();
    } catch (err) {
        logger.error('Redeemer loop error:', err.message);
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
    logger.info(`Trader       : ${config.traderAddress}`);
    logger.info(`Proxy wallet : ${config.proxyWallet}`);
    logger.info(`Size mode    : ${config.sizeMode} (${config.sizePercent}%)`);
    logger.info(`Min trade    : $${config.minTradeSize}`);
    logger.info(`Max position : $${config.maxPositionSize} per market`);
    logger.info(`Auto sell    : ${config.autoSellEnabled ? `ON (+${config.autoSellProfitPercent}%)` : 'OFF'}`);
    logger.info(`Sell mode    : ${config.sellMode}`);
    logger.info(`Min time left: ${config.minMarketTimeLeft}s`);
    logger.info('==========================================');

    try {
        await initClient();
    } catch (err) {
        logger.error('Failed to initialize CLOB client:', err.message);
        process.exit(1);
    }

    try {
        const balance = await getUsdcBalance();
        logger.money(`USDC.e Balance: $${balance.toFixed(2)}`);
    } catch (err) {
        logger.warn('Could not fetch balance:', err.message);
    }

    logger.success(
        config.dryRun
            ? 'Simulation started — watching trader in real-time...'
            : 'Bot started — watching trader in real-time...',
    );

    startWsWatcher(handleTrade);

    await redeemerLoop();
    const redeemerInterval = setInterval(redeemerLoop, config.redeemInterval);

    // Print status every 60 seconds
    const statusInterval = setInterval(printStatus, 60_000);

    const shutdown = () => {
        logger.info('Shutting down...');
        stopWsWatcher();
        clearInterval(redeemerInterval);
        clearInterval(statusInterval);
        setTimeout(() => process.exit(0), 300);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    logger.error('Fatal error:', err.message);
    process.exit(1);
});
