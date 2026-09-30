// =================================================================
// WAJIB JOIN CHANNEL sebelum memakai bot.
//
// Pembeli (bukan owner) yang belum join channel testimoni tidak bisa memakai
// bot: setiap pesan / tombol dijawab dengan ajakan join + tombol "✅ Sudah Join".
//
// Syarat: bot harus menjadi ADMIN di channel tersebut (sama seperti untuk
// posting testimoni) — Telegram hanya mengizinkan bot mengecek anggota channel
// tempat bot menjadi admin. Kalau pengecekan gagal (bot belum admin, channel
// salah), bot TIDAK memblokir pembeli (jualan tetap jalan) dan owner diberi tahu.
//
// ENV (opsional):
//   FORCE_JOIN_CHANNEL  channel yang wajib di-join (default = channel testimoni).
//                       Isi "off" untuk mematikan fitur ini.
//   FORCE_JOIN_LINK     link join (default https://t.me/<username channel>);
//                       wajib diisi kalau channel-nya private (pakai invite link).
// =================================================================

const JOINED_TTL_MS = 10 * 60 * 1000;   // hasil "sudah join" disimpan 10 menit
const NOTJOINED_TTL_MS = 15 * 1000;     // hasil "belum join" disimpan 15 detik
const PROMPT_EVERY_MS = 20 * 1000;      // ajakan join maks. 1x per 20 detik per user
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_CALLBACK = 'fj_check';

function escMd(s) {
    return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

module.exports = function createForceJoin(cfg) {
    const raw = String(process.env.FORCE_JOIN_CHANNEL !== undefined ? process.env.FORCE_JOIN_CHANNEL : (cfg.channel || '')).trim();
    const channel = !raw || /^(off|false|0|no)$/i.test(raw) ? null : raw;
    const link = String(process.env.FORCE_JOIN_LINK || '').trim()
        || (channel && channel.startsWith('@') ? `https://t.me/${channel.slice(1)}` : null);
    const storeName = cfg.storeName || 'toko kami';

    const cache = new Map();       // userId -> { joined, exp }
    const lastPrompt = new Map();  // userId -> ms
    let lastAlert = 0;

    function ownerIds() {
        return (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
    }

    function alertOwner(bot, text) {
        if (Date.now() - lastAlert < ALERT_EVERY_MS) return;
        lastAlert = Date.now();
        for (const id of ownerIds()) bot.telegram.sendMessage(id, text).catch(() => {});
    }

    function cleanup() {
        const now = Date.now();
        if (cache.size > 20000) for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
        if (lastPrompt.size > 20000) for (const [k, t] of lastPrompt) if (now - t > PROMPT_EVERY_MS) lastPrompt.delete(k);
    }

    // true = sudah join, false = belum, null = tidak bisa dicek (jangan blokir)
    async function isMember(bot, userId, fresh) {
        const key = String(userId);
        const c = cache.get(key);
        if (!fresh && c && c.exp > Date.now()) return c.joined;
        try {
            const m = await bot.telegram.getChatMember(channel, userId);
            const st = m && m.status;
            const joined = st === 'creator' || st === 'administrator' || st === 'member'
                || (st === 'restricted' && m.is_member === true);
            cache.set(key, { joined, exp: Date.now() + (joined ? JOINED_TTL_MS : NOTJOINED_TTL_MS) });
            cleanup();
            return joined;
        } catch (e) {
            const desc = String((e && (e.description || e.message)) || e);
            // "user not found" = user memang belum pernah ada di channel
            if (/user not found|participant_id_invalid/i.test(desc)) {
                cache.set(key, { joined: false, exp: Date.now() + NOTJOINED_TTL_MS });
                return false;
            }
            console.error(`[FORCE-JOIN] gagal cek anggota ${channel}:`, desc);
            alertOwner(bot,
                `⚠️ Fitur WAJIB JOIN tidak bisa mengecek anggota ${channel}.\n` +
                `Sebab: ${desc}\n\n` +
                'Pastikan bot sudah menjadi ADMIN di channel tersebut. Selama belum beres, pembeli TIDAK diblokir (bot tetap bisa dipakai).'
            );
            return null;
        }
    }

    function joinKeyboard() {
        const rows = [];
        if (link) rows.push([{ text: '📢 Join Channel', url: link }]);
        rows.push([{ text: '✅ Sudah Join', callback_data: CHECK_CALLBACK }]);
        return { inline_keyboard: rows };
    }

    function joinText() {
        return '🔒 *Wajib Join Channel Dulu*\n\n' +
            `Untuk memakai bot ${escMd(storeName)}, silakan join channel testimoni kami terlebih dahulu:\n` +
            `👉 ${escMd(channel)}\n\n` +
            '📢 Silakan join channel untuk pemberitahuan dan testimoni kami.\n\n' +
            'Setelah join, tekan tombol *✅ Sudah Join* di bawah.';
    }

    async function sendPrompt(ctx) {
        const uid = String(ctx.from.id);
        const last = lastPrompt.get(uid) || 0;
        if (Date.now() - last < PROMPT_EVERY_MS) return; // jangan spam
        lastPrompt.set(uid, Date.now());
        await ctx.reply(joinText(), { parse_mode: 'Markdown', reply_markup: joinKeyboard(), disable_web_page_preview: true })
            .catch(() => ctx.reply(joinText().replace(/\\([_*`\[])/g, '$1').replace(/\*/g, ''), { reply_markup: joinKeyboard() }).catch(() => {}));
    }

    function middleware(bot) {
        return async (ctx, next) => {
            if (!channel) return next();
            // hanya chat pribadi dengan user (bukan grup/channel/update tanpa pengirim)
            if (!ctx.from || ctx.from.is_bot || (ctx.chat && ctx.chat.type !== 'private')) return next();
            if (ownerIds().includes(String(ctx.from.id))) return next();

            const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';

            // Tombol "✅ Sudah Join"
            if (data === CHECK_CALLBACK) {
                const joined = await isMember(bot, ctx.from.id, true);
                if (joined === false) {
                    return ctx.answerCbQuery('❌ Kamu belum join channel. Join dulu lalu tekan "Sudah Join" lagi.', { show_alert: true }).catch(() => {});
                }
                await ctx.answerCbQuery('✅ Terima kasih sudah join!').catch(() => {});
                lastPrompt.delete(String(ctx.from.id));
                return ctx.editMessageText('✅ Terima kasih sudah join channel!\n\nKetik /start untuk mulai belanja.').catch(() => {});
            }

            // Tombol batal pembayaran tetap boleh dipakai walau keluar channel.
            if (data.startsWith('cancel_payment_')) return next();

            const joined = await isMember(bot, ctx.from.id, false);
            if (joined !== false) return next(); // sudah join / tidak bisa dicek -> jangan blokir

            if (ctx.callbackQuery) {
                await ctx.answerCbQuery('🔒 Join channel dulu untuk memakai bot ini.').catch(() => {});
            }
            await sendPrompt(ctx);
        };
    }

    function attach(bot) {
        if (!channel) {
            console.log('[FORCE-JOIN] nonaktif.');
            return;
        }
        console.log(`[FORCE-JOIN] aktif: pembeli wajib join ${channel}.`);
        bot.use(middleware(bot));
    }

    return { attach, isMember, channel, link };
};
