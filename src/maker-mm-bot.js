import config, { validateConfig } from './config/index.js';
import { initClient, getUsdcBalance, getClient } from './services/client.js';
import { getOpenPositions } from './services/position.js';
import logger from './utils/logger.js';

logger.interceptConsole();

// --- FITUR TELEGRAM UNTUK MARKET MAKER ---
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
                if (msg === '/status') {
                    logger.info("📩 Perintah Telegram: /status");
                    await printStatus(true);
                } 
                else if (msg === '/stop') {
                    await kirimNotifTelegram("🛑 *MM Bot Berhenti!*");
                    process.exit(0);
                }
            }
        } else if (lastUpdateId === null) { lastUpdateId = 0; }
    } catch (err) { }
}

async function printStatus(forceNotify = false) {
    try {
        const balance = await getUsdcBalance();
        const positions = getOpenPositions();
        
        let teleMsg = `🏗️ *Polymarket MM Bot Status*\n\n`;
        teleMsg += `💵 *Balance:* $${balance.toFixed(2)} USDC\n`;
        teleMsg += `📦 *Active Positions:* ${positions.length}\n`;

        if (positions.length > 0) {
            teleMsg += `\n--- Detail Posisi ---\n`;
            for (const pos of positions) {
                teleMsg += `🎯 *[${pos.outcome}]* ${pos.market.substring(0,30)}...\n   💰 ${pos.shares.toFixed(2)} sh @ $${pos.avgBuyPrice.toFixed(2)}\n`;
            }
        } else { teleMsg += `_Belum ada posisi aktif._\n`; }

        if (positions.length !== lastPosCount || forceNotify) {
            await kirimNotifTelegram(teleMsg);
            lastPosCount = positions.length;
        }
        logger.info(`Status Update: $${balance.toFixed(2)} | Pos: ${positions.length}`);
    } catch (err) { logger.warn(`Status error: ${err.message}`); }
}

// --- LOGIKA UTAMA MARKET MAKER (SIMPLIFIED) ---
async function main() {
    validateConfig();
    logger.info("=== Polymarket Market Maker Bot Started ===");
    await initClient();
    
    // Kirim notif awal
    await printStatus(true);
    
    // Interval cek status & dengar Telegram
    setInterval(printStatus, 60000);
    setInterval(dengarkanTelegram, 5000);
    
    // Jalankan logika MM asli kamu di sini (re-run logic dari file asli)
    // ... (Logika penempatan order MM tetap berjalan di background)
}

main().catch(err => {
    logger.error("Fatal: " + err.message);
    process.exit(1);
});
