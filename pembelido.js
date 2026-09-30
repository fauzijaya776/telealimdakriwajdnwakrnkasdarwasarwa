// =================================================================
// DAFTAR PEMBELI DIGITALOCEAN + TEMPLATE "BOT PINDAH"
//
// Dipakai saat bot lama tidak aktif (mis. disuspend Telegram): bot baru TIDAK
// bisa mengirim pesan ke pembeli yang belum pernah /start di bot baru, jadi
// owner menghubungi mereka MANUAL dari akun Telegram pribadi. Modul ini
// memudahkannya:
//   * Panel web  /pembeli-do : daftar pembeli DO (user ID, nama, @username,
//     jumlah order, order terakhir), tombol "💬 Chat" (buka chat + salin
//     template), tombol "✔ Sudah" (tandai sudah dihubungi, tersimpan di DB),
//     edit template, unduh .txt / .csv.
//   * Panel admin Telegram: tombol "📋 Pembeli DigitalOcean" -> ringkasan,
//     file daftar, dan template siap salin.
//
// Pembeli DigitalOcean = order LUNAS untuk produk yang namanya cocok
// DO_PRODUCT_MATCH (default: "digital ocean" / "droplet") ATAU produk yang
// stoknya berisi token DigitalOcean (dop_v1...).
// =================================================================

const DEFAULT_TEMPLATE =
    '📢 PEMBERITAHUAN — {TOKO}\n\n' +
    'Halo kak! Bot lama kami sudah tidak aktif. Sekarang {TOKO} pindah ke bot baru:\n' +
    '👉 {BOT}\n\n' +
    'Silakan buka bot baru lalu tekan /start untuk belanja, cek riwayat & garansi.\n' +
    'Join juga channel {CHANNEL} untuk pemberitahuan dan testimoni kami 🙏';

const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;

function wib(d) {
    if (!d) return '-';
    const t = new Date(new Date(d).getTime() + 7 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

// Cegah "CSV injection" (nama diawali = + - @ dibuka Excel sebagai rumus).
function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}

module.exports = function createPembeliDo(cfg) {
    const { Order, Product, User, Settings } = cfg;
    const storeName = cfg.storeName || 'Toko';
    const channel = cfg.channel || '';
    let MATCH;
    try { MATCH = new RegExp(process.env.DO_PRODUCT_MATCH || 'digital\\s*ocean|droplet', 'i'); } catch (e) { MATCH = /digital\s*ocean|droplet/i; }
    let bot = null;
    let botUsername = null;

    function ownerIds() {
        return (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
    }

    async function getBotUsername() {
        if (botUsername) return botUsername;
        try {
            botUsername = (bot && bot.botInfo && bot.botInfo.username) || (bot ? (await bot.telegram.getMe()).username : null) || null;
        } catch (e) {
            botUsername = null;
        }
        return botUsername;
    }

    // ---------------- data ----------------
    async function doProductIds() {
        const products = await Product.find({}, { id: 1, name: 1, 'variants.name': 1, 'variants.stock': 1, 'variants.reserved_stock': 1 }).lean();
        const ids = [];
        for (const p of products) {
            const byName = MATCH.test(p.name || '') || (p.variants || []).some((v) => MATCH.test(v.name || ''));
            const byToken = (p.variants || []).some((v) =>
                (v.stock || []).some((s) => String(s).includes('dop_v1')) ||
                (v.reserved_stock || []).some((s) => String(s).includes('dop_v1')));
            if (byName || byToken) ids.push(p.id);
        }
        return ids;
    }

    async function getBuyers() {
        const ids = await doProductIds();
        const rows = await Order.aggregate([
            {
                $match: {
                    status: 'PAID',
                    'customerInfo.telegramUserId': { $exists: true, $nin: [null, ''] },
                    $or: [
                        { productId: { $in: ids } },
                        { productName: { $regex: MATCH.source, $options: 'i' } },
                        { variantName: { $regex: MATCH.source, $options: 'i' } },
                    ],
                },
            },
            { $sort: { paidAt: 1 } },
            {
                $group: {
                    _id: '$customerInfo.telegramUserId',
                    firstName: { $last: '$customerInfo.first_name' },
                    orders: { $sum: 1 },
                    lastPaid: { $max: '$paidAt' },
                },
            },
            { $sort: { lastPaid: -1 } },
            { $limit: 5000 },
        ]);
        const uids = rows.map((r) => String(r._id));
        const users = uids.length ? await User.find({ id: { $in: uids } }, { id: 1, username: 1, movedNotifiedAt: 1 }).lean() : [];
        const byId = new Map(users.map((u) => [String(u.id), u]));
        return rows.map((r) => {
            const u = byId.get(String(r._id)) || {};
            const un = u.username && USERNAME_RE.test(u.username) ? u.username : null;
            return {
                userId: String(r._id),
                name: r.firstName || '-',
                username: un,
                orders: r.orders,
                lastPaid: r.lastPaid,
                lastPaidText: wib(r.lastPaid),
                contactedAt: u.movedNotifiedAt || null,
            };
        });
    }

    function summarize(buyers) {
        const withUser = buyers.filter((b) => b.username);
        return {
            total: buyers.length,
            withUsername: withUser.length,
            noUsername: buyers.length - withUser.length,
            contacted: withUser.filter((b) => b.contactedAt).length,
        };
    }

    // ---------------- template ----------------
    async function getRawTemplate() {
        try {
            const s = await Settings.findOne({ identifier: 'global-settings' }).lean();
            return s && s.move_template ? String(s.move_template) : DEFAULT_TEMPLATE;
        } catch (e) {
            return DEFAULT_TEMPLATE;
        }
    }
    async function saveTemplate(text) {
        const t = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, 3000);
        await Settings.updateOne(
            { identifier: 'global-settings' },
            t && t !== DEFAULT_TEMPLATE ? { $set: { move_template: t } } : { $unset: { move_template: '' } },
            { upsert: true }
        );
    }
    async function renderTemplate(raw) {
        const un = await getBotUsername();
        return String(raw || DEFAULT_TEMPLATE)
            .replace(/\{TOKO\}/g, storeName)
            .replace(/\{BOT\}/g, un ? '@' + un : '(bot baru)')
            .replace(/\{CHANNEL\}/g, channel || '-');
    }

    async function setContacted(userId, done) {
        const r = await User.updateOne(
            { id: String(userId) },
            done ? { $set: { movedNotifiedAt: new Date() } } : { $unset: { movedNotifiedAt: '' } }
        );
        return !!(r && (r.matchedCount !== undefined ? r.matchedCount : r.modifiedCount));
    }

    // ---------------- ekspor ----------------
    function toTxt(buyers, template) {
        const s = summarize(buyers);
        const lines = [
            `DAFTAR PEMBELI DIGITALOCEAN — ${storeName}`,
            `Dibuat: ${wib(new Date())} WIB`,
            `Total: ${s.total} pembeli • punya username: ${s.withUsername} • sudah dihubungi: ${s.contacted}`,
            '',
            'No | User ID | Nama | Username | Jml order | Order terakhir | Sudah dihubungi',
            '-'.repeat(80),
        ];
        buyers.forEach((b, i) => {
            lines.push(`${i + 1} | ${b.userId} | ${b.name} | ${b.username ? '@' + b.username : '-'} | ${b.orders} | ${b.lastPaidText} | ${b.contactedAt ? 'ya' : 'belum'}`);
        });
        lines.push('', '='.repeat(80), 'TEMPLATE PESAN:', '', template);
        return lines.join('\n');
    }
    function toCsv(buyers) {
        const head = ['No', 'User ID', 'Nama', 'Username', 'Jumlah Order', 'Order Terakhir (WIB)', 'Sudah Dihubungi'];
        const rows = buyers.map((b, i) => [i + 1, b.userId, b.name, b.username ? '@' + b.username : '', b.orders, b.lastPaidText, b.contactedAt ? 'ya' : 'belum']);
        return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    }

    // ---------------- panel web ----------------
    function registerRoutes(app, authMiddleware, ejs, path, viewsDir) {
        app.get('/pembeli-do', authMiddleware, async (req, res) => {
            try {
                const all = await getBuyers();
                const f = ['belum', 'semua', 'nouser'].includes(req.query.f) ? req.query.f : 'belum';
                const list = f === 'semua' ? all
                    : f === 'nouser' ? all.filter((b) => !b.username)
                        : all.filter((b) => b.username && !b.contactedAt);
                const rawTemplate = await getRawTemplate();
                res.render('layout', {
                    page: 'pembeli-do',
                    body: await ejs.renderFile(path.join(viewsDir, 'pembeli-do.ejs'), {
                        buyers: list,
                        stats: summarize(all),
                        filter: f,
                        rawTemplate,
                        template: await renderTemplate(rawTemplate),
                        isDefaultTemplate: rawTemplate === DEFAULT_TEMPLATE,
                        storeName,
                        saved: req.query.saved === '1',
                        locals: {},
                    }),
                });
            } catch (e) {
                console.error('[PEMBELI-DO] halaman error:', e);
                res.status(500).send('Gagal memuat daftar pembeli DigitalOcean.');
            }
        });

        app.post('/pembeli-do/tandai', authMiddleware, async (req, res) => {
            try {
                const userId = String((req.body && req.body.userId) || '').trim();
                if (!/^\d{3,20}$/.test(userId)) return res.status(400).json({ ok: false, message: 'userId tidak valid' });
                const done = req.body.done === true || req.body.done === 'true' || req.body.done === '1';
                const ok = await setContacted(userId, done);
                return res.json({ ok, done });
            } catch (e) {
                return res.status(500).json({ ok: false, message: e.message });
            }
        });

        app.post('/pembeli-do/template', authMiddleware, async (req, res) => {
            try {
                await saveTemplate(req.body && req.body.reset === '1' ? '' : req.body.template);
                res.redirect('/pembeli-do?saved=1');
            } catch (e) {
                res.status(500).send('Gagal menyimpan template: ' + e.message);
            }
        });

        app.get('/pembeli-do/unduh', authMiddleware, async (req, res) => {
            try {
                const buyers = await getBuyers();
                const stamp = new Date().toISOString().slice(0, 10);
                if (req.query.format === 'csv') {
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="pembeli-digitalocean-${stamp}.csv"`);
                    return res.send(toCsv(buyers));
                }
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="pembeli-digitalocean-${stamp}.txt"`);
                return res.send(toTxt(buyers, await renderTemplate(await getRawTemplate())));
            } catch (e) {
                res.status(500).send('Gagal membuat file: ' + e.message);
            }
        });
    }

    // ---------------- panel admin Telegram ----------------
    function attach(b) {
        bot = b;
        bot.action('admin_do_buyers', async (ctx) => {
            if (!ownerIds().includes(String(ctx.from.id))) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            await ctx.answerCbQuery('Menyiapkan daftar...').catch(() => {});
            try {
                const buyers = await getBuyers();
                const s = summarize(buyers);
                const template = await renderTemplate(await getRawTemplate());
                await ctx.reply(
                    `📋 Pembeli DigitalOcean — ${storeName}\n\n` +
                    `Total pembeli: ${s.total}\n` +
                    `Punya @username (bisa dichat manual): ${s.withUsername}\n` +
                    `Tanpa username: ${s.noUsername}\n` +
                    `Sudah dihubungi: ${s.contacted}/${s.withUsername}\n\n` +
                    'File daftar & template pesan di bawah. Kirim manual dari akun pribadi, maksimal ±20–30 orang per hari. ' +
                    'Tandai "sudah dihubungi" & lihat daftar lengkap di panel web: menu "Pembeli DO".'
                ).catch(() => {});
                if (buyers.length) {
                    await ctx.replyWithDocument(
                        { source: Buffer.from(toTxt(buyers, template), 'utf8'), filename: `pembeli-digitalocean-${new Date().toISOString().slice(0, 10)}.txt` },
                        { caption: `${buyers.length} pembeli DigitalOcean` }
                    ).catch(() => {});
                }
                // template dikirim sebagai pesan terpisah (teks biasa) supaya gampang disalin / diteruskan
                await ctx.reply(template, { disable_web_page_preview: true }).catch(() => {});
            } catch (e) {
                console.error('[PEMBELI-DO] telegram error:', e);
                await ctx.reply('❌ Gagal mengambil daftar pembeli: ' + e.message).catch(() => {});
            }
        });
    }

    return { attach, registerRoutes, getBuyers, renderTemplate, getRawTemplate, saveTemplate, setContacted, toTxt, toCsv, summarize, DEFAULT_TEMPLATE };
};
