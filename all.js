// =================================================================
// SCRIPT GABUNGAN LENGKAP: ADMIN PANEL (EXPRESS) + TELEGRAM BOT (TELEGRAF)
// Versi ini mempertahankan semua blok kode asli tanpa penyederhanaan.
// =================================================================

// === 1. IMPOR & KONFIGURASI AWAL ===
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const session = require('express-session');
const ejs = require('ejs');
const multer = require('multer');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const moment = require('moment-timezone');

// Impor modul lokal
const { connectDB, User, Product, Order, Settings, slimPaymentDetails } = require('./db');
const dana = require('./qris_dana');
const tokopay = require('./qris_tokopay');
const qrin = require('./qris_qrin');
const pakasir = require('./qris_pakasir');
const linkqu = require('./qris_linkqu');
const adminModule = require('./admin');
const QRCode = require('qrcode');
const docheck = require('./docheck');

// Testimoni otomatis: struk bergambar diposting ke channel setiap order lunas & akun terkirim.
// Channel default @testiAlimStore; ganti lewat env TESTI_CHANNEL, atau matikan dengan TESTI_CHANNEL=off.
// Butuh: npm install @napi-rs/canvas  (tanpa itu testimoni tetap diposting sebagai teks).
const createTestimoni = require('./testimoni');
const testimoni = createTestimoni({
    channel: process.env.TESTI_CHANNEL !== undefined ? process.env.TESTI_CHANNEL : '@testiAlimStore',
    assetsDir: path.join(__dirname, 'testimoni-assets'),
    Order, // antrean testimoni disimpan di dokumen Order (tahan restart + coba ulang)
    brand: {
        name1: 'ALIM', name2: 'STORE', displayName: 'ALIM STORE', monogram: 'A', trxPrefix: 'ALM',
        tagline: 'Produk digital · Order otomatis 24 jam',
        footer: 'Produk digital dikirim otomatis setelah pembayaran terkonfirmasi · alimcloud.id',
        feeLabel: 'Biaya QRIS',
        logoFile: 'logo.png', // testimoni-assets/logo.png (logo Alim Store)
        colors: { name1: '#1ba0c8', name2: '#d8a13a', dark: '#137a99', grad: ['#1ba0c8', '#d8a13a'], totalBg: ['#e8f6fb', '#fbf3e4'], heart: '#1ba0c8' },
    },
    // Mode senyap (default ON) — diatur owner lewat Admin Panel Telegram -> "Testimoni Senyap".
    isSilent: async () => {
        const st = await Settings.findOne({ identifier: 'global-settings' }).lean();
        return st && typeof st.testi_silent === 'boolean' ? st.testi_silent : true;
    },
    notifyOwner: async (text) => {
        const owners = (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
        for (const id of owners) await bot.telegram.sendMessage(id, text).catch(() => {});
    },
});
// Daftar pembeli DigitalOcean + template "bot pindah" (panel web /pembeli-do & panel admin Telegram).
const createPembeliDo = require('./pembelido');
const pembeliDo = createPembeliDo({
    Order, Product, User, Settings,
    storeName: 'ALIM STORE',
    channel: process.env.TESTI_CHANNEL && !/^off$/i.test(process.env.TESTI_CHANNEL) ? process.env.TESTI_CHANNEL : '@testiAlimStore',
});
// === 2. INISIALISASI & KONEKSI DATABASE ===
connectDB(); 

// Inisialisasi Express App dan Telegraf Bot
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
// Setiap update Telegram diproses di LATAR BELAKANG. Tanpa ini Telegraf menunggu
// handler selesai sebelum mengambil update berikutnya, jadi proses panjang
// (cek Gmail, /statusdo, /cekdo, membuat QRIS) membuat bot diam untuk SEMUA pembeli.
// Error tetap diteruskan ke bot.catch seperti biasa.
bot.use((ctx, next) => {
    Promise.resolve()
        .then(next)
        .catch((err) => {
            try {
                if (typeof bot.handleError === 'function') return bot.handleError(err, ctx);
            } catch (e) { /* jatuh ke log di bawah */ }
            console.error('[BOT] Error tak tertangani:', err);
        })
        .catch((e) => console.error('[BOT] Error di penanganan error:', e));
});
// Tombol "Matikan notifikasi" di bawah setiap testimoni channel. Didaftarkan PALING AWAL
// supaya subscriber channel yang menekannya tidak ikut tercatat sebagai user bot.
testimoni.attach(bot);

// /testiulang <ID order> — kirim ulang testimoni order tertentu ke channel (khusus owner).
// Berguna untuk order yang testimoninya terlanjur tidak masuk sebelum antrean ada.
bot.command('testiulang', async (ctx) => {
    const owners = (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
    if (!owners.includes(String(ctx.from.id))) return;
    const orderId = (ctx.message.text.split(/\s+/)[1] || '').trim();
    if (!orderId) {
        return ctx.reply('Format: /testiulang <ID order>\nContoh: /testiulang ALIM-123456789-1790000058421\n(ID order ada di notifikasi "Order Baru")');
    }
    const r = await testimoni.repost(bot, orderId).catch((e) => ({ posted: false, reason: e.message }));
    return ctx.reply(r.posted ? `✅ Testimoni ${orderId} berhasil diposting ke channel.` : `❌ Testimoni ${orderId} tidak diposting: ${r.reason}`);
});
const PORT = process.env.PORT || 3000;
const GROUP_NOTIF_ID = process.env.GROUP_NOTIF_ID;

// Ambil userStates dari modul admin dan inisialisasi sesi pembayaran
const { userStates } = adminModule;
const paymentSessions = new Map();

// Nomor WhatsApp admin untuk Pesan Manual / Pre-Order (PO).
// Bisa dioverride lewat .env (PO_WA_NUMBER); default sesuai kode.
const PO_WA_NUMBER = (process.env.PO_WA_NUMBER || '6285753323094').replace(/\D/g, '');
const PO_WA_URL = `https://wa.me/${PO_WA_NUMBER}?text=${encodeURIComponent('Halo admin, saya mau pesan manual (PO).')}`;

// -----------------------------------------------------------------
// FORMAT TAMPILAN AKUN UNTUK CUSTOMER
// DigitalOcean (dop_v1|email|password|2fa) -> berlabel; produk biasa
// dgn pembatas '|' -> tiap bagian ke baris sendiri; tanpa pembatas -> apa adanya.
// -----------------------------------------------------------------
function formatAccountItem(item) {
    if (!item || typeof item !== 'string') return item;
    const allLines = item.split(/\r?\n/);
    const firstLine = allLines[0];
    const extra = allLines.slice(1).filter((l) => l.trim());

    if (firstLine.includes('dop_v1')) {
        const parts = firstLine.split('|').map((p) => p.trim());
        const labels = ['api key', 'email', 'password', '2fa'];
        const out = [];
        for (let i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            const label = labels[i] || `field${i + 1}`;
            out.push(`${label} = ${parts[i]}`);
        }
        if (extra.length) out.push(...extra);
        return out.join('\n');
    }

    if (firstLine.includes('|')) {
        const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
        const out = [...parts];
        if (extra.length) out.push(...extra);
        return out.join('\n');
    }

    return item;
}

function formatItemsForCustomer(items) {
    if (!Array.isArray(items)) return '';
    if (items.length === 1) return formatAccountItem(items[0]);
    const anyMulti = items.some((it) => formatAccountItem(it).includes('\n'));
    const sep = anyMulti ? '\n\n' : '\n';
    return items
        .map((item, i) => {
            const f = formatAccountItem(item);
            return f.includes('\n') ? `${i + 1}.\n${f}` : `${i + 1}. ${f}`;
        })
        .join(sep);
}

function formatItemsForFile(items) {
    if (!Array.isArray(items)) return '';
    return items.map(formatAccountItem).join('\n\n');
}

// =============================================================
// KEBIJAKAN RETENSI DATA (MongoDB Atlas M0 hanya 512MB)
// =============================================================
// Order yang tidak jadi dibayar (PENDING/EXPIRED/CANCELLED/FAILED) dihapus
// otomatis oleh TTL index MongoDB setelah sekian jam. Invoice hanya hidup
// 3 menit, jadi 24 jam sudah sangat longgar.
const JUNK_ORDER_TTL_HOURS = parseInt(process.env.JUNK_ORDER_TTL_HOURS || '24', 10);
// Isi akun (reservedItems) pada order LUNAS dikosongkan setelah sekian hari.
// Order-nya tetap ada, jadi statistik & Riwayat Transaksi tidak terpengaruh.
const PAID_ITEMS_RETENTION_DAYS = parseInt(process.env.PAID_ITEMS_RETENTION_DAYS || '30', 10);
// Seberapa sering job pembersihan berjalan di dalam bot.
const MAINTENANCE_INTERVAL_HOURS = 6;

function junkOrderExpiry() {
    return new Date(Date.now() + JUNK_ORDER_TTL_HOURS * 60 * 60 * 1000);
}
// QRIS Pakasir tetap bisa dibayar ±24 jam -> order Pakasir disimpan minimal 26 jam
// supaya pembayaran telat masih bisa dicocokkan & akunnya dikirim.
const PAKASIR_KEEP_HOURS = Math.max(JUNK_ORDER_TTL_HOURS, 26);
function pakasirOrderExpiry() {
    return new Date(Date.now() + PAKASIR_KEEP_HOURS * 60 * 60 * 1000);
}

// Pembersihan berkala: TTL index sudah menangani penghapusan order sampah,
// job ini menangani hal yang tidak bisa dilakukan TTL (mengosongkan field)
// plus jaring pengaman kalau TTL index belum sempat terbentuk.
async function runStorageMaintenance() {
    try {
        // 0. PEMULIHAN STOK NYANGKUT.
        // Kalau bot mati/restart di tengah pembayaran, order tetap PENDING dan
        // stoknya tertinggal di reserved_stock selamanya (stok "hilang").
        // Order yang masih PENDING > 1 jam pasti sudah gagal (invoice cuma 3
        // menit), jadi stoknya aman dikembalikan.
        const strandedCutoff = new Date(Date.now() - 60 * 60 * 1000);
        const stranded = await Order.find({
            status: 'PENDING',
            createdAt: { $lt: strandedCutoff },
            reservedItems: { $exists: true, $ne: [] }
        }).lean();

        let restored = 0;
        for (const order of stranded) {
            try {
                // KLAIM dulu (PENDING -> EXPIRED secara atomik), baru kembalikan stok.
                // Kalau order keburu dibayar/diproses, klaim gagal & stok tidak disentuh
                // (mencegah akun terkirim ke pembeli SEKALIGUS balik ke stok).
                const claimed = await Order.findOneAndUpdate(
                    { _id: order._id, status: 'PENDING' },
                    { $set: { status: 'EXPIRED' } }
                );
                if (!claimed) continue;
                restored += 1;
                await Product.updateOne(
                    { id: order.productId, 'variants.slug': order.variantSlug },
                    {
                        $push: { 'variants.$.stock': { $each: order.reservedItems } },
                        $pull: { 'variants.$.reserved_stock': { $in: order.reservedItems } }
                    }
                );
            } catch (itemError) {
                console.error(`Gagal memulihkan stok order ${order.orderId}:`, itemError.message);
            }
        }
        if (restored > 0) {
            console.log(`♻️  Maintenance: stok dari ${restored} order nyangkut dikembalikan.`);
        }

        const junkCutoff = new Date(Date.now() - JUNK_ORDER_TTL_HOURS * 60 * 60 * 1000);
        const pakasirCutoff = new Date(Date.now() - PAKASIR_KEEP_HOURS * 60 * 60 * 1000);
        const deleted = await Order.deleteMany({
            status: { $ne: 'PAID' },
            createdAt: { $lt: junkCutoff },
            // order Pakasir ditahan lebih lama (pembayaran telat masih mungkin masuk)
            $or: [{ paymentGateway: { $ne: 'pakasir' } }, { createdAt: { $lt: pakasirCutoff } }],
        });

        const stripCutoff = new Date(Date.now() - PAID_ITEMS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const stripped = await Order.updateMany(
            {
                status: 'PAID',
                createdAt: { $lt: stripCutoff },
                $or: [
                    { reservedItems: { $exists: true, $ne: [] } },
                    { paymentDetails: { $exists: true, $ne: null } }
                ]
            },
            { $set: { reservedItems: [] }, $unset: { paymentDetails: '' } }
        );

        if (deleted.deletedCount > 0 || stripped.modifiedCount > 0) {
            console.log(`🧹 Maintenance: ${deleted.deletedCount} order sampah dihapus, ${stripped.modifiedCount} order lunas lama diringkas.`);
        }
    } catch (error) {
        console.error('Storage maintenance error:', error.message);
    }
}

async function sendAdminNotification(bot, order) {
    if (!GROUP_NOTIF_ID) {
        console.warn('GROUP_NOTIF_ID tidak diatur di .env, notifikasi admin dilewati.');
        return;
    }

    // 1. Pesan notifikasi (nama pembeli/produk di-escape supaya Markdown tidak rusak)
    const message = [
        '✅ *Transaksi Baru Berhasil*',
        `*Waktu:* ${moment(order.paidAt || new Date()).tz('Asia/Jakarta').format('HH:mm DD/MM/YY')}`,
        `*User:* ${escapeMd(order.customerInfo?.first_name || '-')} (${order.customerInfo?.telegramUserId || '-'})`,
        `*Produk:* ${escapeMd(order.productName)} - ${escapeMd(order.variantName)}`,
        `*Jumlah:* ${order.quantity}x`,
        `*Total:* Rp ${Number(order.totalPaid || order.amount || 0).toLocaleString('id-ID')}`,
        `*Metode:* ${escapeMd(String(order.paymentGateway || '-').toUpperCase())}`,
        `*ID Order:* ${escapeMd(order.orderId)}`
    ].join('\n');
    try {
        await bot.telegram.sendMessage(GROUP_NOTIF_ID, message, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.telegram.sendMessage(GROUP_NOTIF_ID, message.replace(/\\([_*`\[])/g, '$1').replace(/\*/g, ''))
            .catch((e2) => console.error(`Gagal mengirim notifikasi admin untuk order ${order.orderId}:`, e2.message));
    }

    // 2. File .txt akun (tetap dikirim walau pesan di atas gagal)
    try {
        const fileContent = formatItemsForFile(order.reservedItems);
        await bot.telegram.sendDocument(
            GROUP_NOTIF_ID,
            { source: Buffer.from(fileContent || '(kosong)', 'utf-8'), filename: `akun_${order.orderId}.txt` },
            { caption: `Akun untuk order ${order.orderId}` }
        );
    } catch (error) {
        console.error(`Gagal mengirim file notifikasi admin untuk order ${order.orderId}:`, error.message);
    }
}

// =================================================================
// PENGIRIMAN AKUN KE CUSTOMER — TAHAN BANTING
// Menangani "sudah bayar tapi akun tidak terkirim": coba Markdown ->
// fallback teks biasa -> kalau tetap gagal, LAPOR owner + file akun untuk
// dikirim manual, dan order tidak ditandai delivered. Tidak pernah melempar.
// =================================================================
function ownerIdList() {
    return (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
}

async function markOrderDelivered(orderId) {
    try {
        await Order.updateOne({ orderId }, { $set: { delivered: true, deliveredAt: new Date() } });
    } catch (e) {
        console.error(`[DELIVERY] Gagal set delivered utk ${orderId}:`, e.message);
    }
}

// Notifikasi ke OWNER tiap ada order yang berhasil dibayar:
// berisi User ID pembeli, produk, jumlah, dan harga. Dikirim ke DM owner
// (OWNER_ID), terpisah dari notifikasi grup (GROUP_NOTIF_ID).
async function notifyOwnerNewOrder(order) {
    const owners = ownerIdList();
    if (owners.length === 0) return;

    let waktu;
    try {
        waktu = moment(order.paidAt || new Date()).tz('Asia/Jakarta').format('HH:mm DD/MM/YY');
    } catch (e) {
        waktu = new Date().toISOString();
    }

    const nama = order.customerInfo?.first_name ? ` (${escapeMd(order.customerInfo.first_name)})` : '';
    const msg = [
        '🛒 *Order Baru — Sudah Dibayar*' + (order.latePaid ? ' (bayar telat)' : ''),
        `👤 User ID: \`${order.customerInfo?.telegramUserId || '-'}\`${nama}`,
        `📦 Produk: ${escapeMd(order.productName || '-')}${order.variantName ? ' - ' + escapeMd(order.variantName) : ''}`,
        `🔢 Jumlah: ${order.quantity || 1}x`,
        `💰 Harga: Rp ${Number(order.amount || 0).toLocaleString('id-ID')}` +
            (order.totalPaid && order.totalPaid !== order.amount ? ` (dibayar Rp ${Number(order.totalPaid).toLocaleString('id-ID')} termasuk biaya QRIS)` : ''),
        `💳 Metode: ${escapeMd((order.paymentGateway || '-').toUpperCase())}`,
        `🧾 Order ID: \`${order.orderId}\``,
        `🕒 ${waktu}`,
    ];
    const text = msg.join('\n');

    for (const ownerId of owners) {
        try {
            await bot.telegram.sendMessage(ownerId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            // Masih gagal format -> kirim ulang sebagai teks biasa (notif tidak boleh hilang).
            try {
                await bot.telegram.sendMessage(ownerId, text.replace(/\\([_*`\[])/g, '$1').replace(/[*`]/g, ''));
            } catch (e2) {
                console.error(`[ORDER-NOTIF] gagal kirim ke owner ${ownerId}:`, e2.message);
            }
        }
    }
}

async function alertOwnerDeliveryFailed(order, reason) {
    const owners = ownerIdList();
    if (owners.length === 0) return;
    const head = [
        '🚨 *GAGAL KIRIM AKUN KE CUSTOMER*',
        '',
        `Order \`${order.orderId}\` sudah *DIBAYAR* tetapi akun *GAGAL terkirim*.`,
        `User: \`${order.customerInfo?.telegramUserId || '-'}\``,
        `Produk: ${escapeMd(order.productName)} - ${escapeMd(order.variantName)}`,
        `Jumlah: ${order.quantity}x`,
        `Sebab: ${escapeMd(reason)}`,
        '',
        `Kirim manual akun di file berikut, lalu jalankan \`/resend ${order.orderId}\`.`,
    ].join('\n');
    const fileContent = formatItemsForFile(order.reservedItems || []);
    for (const o of owners) {
        await bot.telegram.sendMessage(o, head, { parse_mode: 'Markdown' })
            .catch(() => bot.telegram.sendMessage(o, head.replace(/\\([_*`\[])/g, '$1').replace(/[*`]/g, '')).catch(() => {}));
        await bot.telegram.sendDocument(
            o,
            { source: Buffer.from(fileContent || '(kosong)', 'utf-8'), filename: `BELUM_TERKIRIM_${order.orderId}.txt` },
            { caption: `Akun order ${order.orderId} (belum terkirim ke customer)` }
        ).catch(() => {});
    }
}

async function sendMessageWithFallback(chatId, markdownMsg) {
    try {
        await bot.telegram.sendMessage(chatId, markdownMsg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.warn(`[DELIVERY] Markdown gagal (${e.message}), coba teks biasa...`);
        // PENTING: isi akun (email/password) TIDAK BOLEH diubah. Dulu karakter _ * ` dihapus
        // sehingga "john_doe@gmail.com" terkirim jadi "johndoe@gmail.com". Sekarang hanya
        // pembatas blok ``` yang dibuang; teks lain dikirim apa adanya tanpa format.
        const plain = markdownMsg.replace(/```\n?/g, '');
        await bot.telegram.sendMessage(chatId, plain); // tanpa parse_mode
    }
}

async function deliverAccountsToCustomer(order, methodLabel) {
    const chatId = order.customerInfo?.telegramUserId;
    if (!chatId) {
        await alertOwnerDeliveryFailed(order, 'telegramUserId customer kosong');
        return false;
    }

    let snk = null;
    try {
        const product = await Product.findOne({ id: order.productId });
        const variant = product ? product.variants.find((v) => v.slug === order.variantSlug) : null;
        snk = variant && variant.snk ? variant.snk : null;
    } catch (e) { /* SNK opsional */ }
    const hasSnk = snk && snk.trim() !== '' && snk.trim() !== '-';

    // Branding ALIM STORE dipertahankan.
    const infoLine =
        `*Info Pembelian:*\n– Total: Rp ${Number(order.totalPaid || order.amount).toLocaleString('id-ID')}\n` +
        `– Metode: ${methodLabel}\n– ID Transaksi: \`${order.orderId}\``;
    const header = `🧾 *Pembelian Berhasil*\n\nTerima kasih!, Jika Ada Pertanyaan Silahkan Chat Admin Di wa.me/6285753323094\n\n`;

    try {
        if (order.quantity < 10) {
            const formattedItems = formatItemsForCustomer(order.reservedItems);
            let msg = header + `${infoLine}\n\n` +
                "```\n" + `${order.productName.toUpperCase()}\n${formattedItems}` + "\n```";
            if (hasSnk) msg += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
            await sendMessageWithFallback(chatId, msg);
        } else {
            let msg = header + `${infoLine}\n\n` +
                `Anda membeli *${order.quantity}* item. Akun Anda dikirim dalam file terpisah.`;
            if (hasSnk) msg += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
            await sendMessageWithFallback(chatId, msg);

            const fileContent = formatItemsForFile(order.reservedItems);
            await bot.telegram.sendDocument(
                chatId,
                { source: Buffer.from(fileContent, 'utf-8'), filename: `akun_${order.orderId}.txt` },
                { caption: `Akun untuk order ${order.orderId}` }
            );
        }

        const wasFirstDelivery = !order.delivered;
        await markOrderDelivered(order.orderId);
        // Notif grup + owner + testimoni channel hanya saat pengiriman PERTAMA (bukan saat /resend).
        if (wasFirstDelivery) {
            if (GROUP_NOTIF_ID) await sendAdminNotification(bot, order).catch(() => {});
            await notifyOwnerNewOrder(order).catch(() => {});
            // Testimoni ke channel — sengaja TIDAK di-await: posting ke channel tidak boleh
            // menahan atau menggagalkan pengiriman akun ke customer.
            testimoni.enqueue(bot, order, methodLabel).catch((e) => console.error('[TESTI]', e.message));
        }
        return true;
    } catch (err) {
        console.error(`[DELIVERY] GAGAL kirim akun order ${order.orderId}:`, err.message);
        await alertOwnerDeliveryFailed(order, err.message || String(err));
        return false;
    }
}

async function handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId) {
    // Dipanggil jika pembuatan invoice gagal SETELAH stok berhasil dicadangkan.
    if (!reservedItems || reservedItems.length === 0) return;
    console.log(`[RECOVERY] Error saat membuat invoice untuk order ${internalOrderId}. Mengembalikan ${reservedItems.length} item stok.`);
    try {
        // 1. Tandai GAGAL dulu (hanya kalau masih PENDING). Kalau order ternyata sudah
        //    dibayar/diproses, stok TIDAK dikembalikan (mencegah akun dijual dua kali).
        const orderQuery = { $or: [{ orderId: internalOrderId }, { internalRefId: internalOrderId }] };
        const claimed = await Order.findOneAndUpdate({ ...orderQuery, status: 'PENDING' }, { $set: { status: 'FAILED' } });
        if (!claimed && await Order.exists(orderQuery)) {
            console.warn(`[RECOVERY] Order ${internalOrderId} sudah tidak PENDING — stok tidak dikembalikan.`);
            return;
        }
        // 2. Kembalikan stok yang dicadangkan ke stok utama
        await Product.updateOne(
            { id: productId, "variants.slug": variantSlug },
            {
                $pull: { "variants.$.reserved_stock": { $in: reservedItems } },
                $push: { "variants.$.stock": { $each: reservedItems } }
            }
        );
        console.log(`[RECOVERY] Stok untuk order ${internalOrderId} berhasil dikembalikan.`);
    } catch (recoveryError) {
        console.error(`[FATAL RECOVERY ERROR] Gagal mengembalikan stok untuk order ${internalOrderId}:`, recoveryError);
        for (const id of ownerIdList()) {
            await bot.telegram.sendMessage(id, `🚨 Gagal mengembalikan stok order ${internalOrderId}: ${recoveryError.message}\nCek reserved_stock produk ${productId}/${variantSlug}.`).catch(() => {});
        }
    }
}
// =================================================================
// BAGIAN A: KODE ADMIN PANEL (DARI app.js)
// =================================================================

// Setup middleware dan view engine untuk Express
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'assets')));

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'public', 'uploads');
        await fs.mkdir(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: true }));
// verify: simpan body mentah untuk validasi tanda tangan webhook QRIN.
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(session({
    // Secret dari env; kalau kosong dibuat acak tiap bot menyala (login ulang setelah restart).
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    // sameSite 'strict' = cookie login tidak ikut terkirim dari situs lain (anti CSRF).
    cookie: { maxAge: 60 * 60 * 1000, httpOnly: true, sameSite: 'strict' }
}));

// Login panel web diambil dari env (Render -> Environment):
//   ADMIN_USERNAME=...   ADMIN_PASSWORD=...
// Kalau belum diisi, sementara masih memakai gen/gen (owner diberi peringatan).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'gen';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gen';
const ADMIN_DEFAULT_LOGIN = !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD;
if (ADMIN_DEFAULT_LOGIN) console.warn('[PANEL] ADMIN_USERNAME/ADMIN_PASSWORD belum diisi di env -> login panel masih gen/gen (TIDAK AMAN).');

function safeEqual(a, b) {
    const crypto = require('crypto');
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Batasi percobaan login salah: 5x per 15 menit per IP.
const loginFails = new Map();
function clientIp(req) {
    // Ambil entri TERAKHIR X-Forwarded-For (ditambahkan proxy Render, tidak bisa dipalsukan
    // pembeli); entri depan bisa diisi sembarang oleh penyerang.
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(req.socket.remoteAddress || '');
}

const authMiddleware = (req, res, next) => {
    if (req.session.loggedin) {
        res.locals.user = req.session.user;
        next();
    } else {
        res.redirect('/login');
    }
};

// --- Rute Otentikasi ---
app.get('/login', (req, res) => res.render('login', { error: req.query.error, success: req.query.success, locals: {} }));

app.post('/login', (req, res) => {
    const ip = clientIp(req);
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (rec && rec.count >= 5 && now - rec.first < 15 * 60 * 1000) {
        return res.redirect('/login?error=' + encodeURIComponent('Terlalu banyak percobaan. Coba lagi 15 menit lagi.'));
    }
    const { username, password } = req.body;
    if (safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD)) {
        loginFails.delete(ip);
        req.session.regenerate(() => {
            req.session.loggedin = true;
            req.session.user = { username: String(username) };
            res.redirect('/');
        });
    } else {
        if (!rec || now - rec.first >= 15 * 60 * 1000) loginFails.set(ip, { count: 1, first: now });
        else rec.count += 1;
        if (loginFails.size > 5000) {
            // buang catatan yang sudah lewat 15 menit saja (bukan semuanya)
            for (const [k, v] of loginFails) if (now - v.first >= 15 * 60 * 1000) loginFails.delete(k);
        }
        res.redirect('/login?error=Invalid username or password');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- Rute API untuk MENGAMBIL stok ---
app.post('/api/take-stock', async (req, res) => {
    try {
        // Keamanan: wajib menyertakan kunci yang cocok dengan STOCK_API_KEY (.env).
        // Kirim lewat header 'X-API-Key' atau field 'api_key' di body.
        const kunci = req.headers['x-api-key'] || (req.body && req.body.api_key);
        if (!process.env.STOCK_API_KEY || kunci !== process.env.STOCK_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: API key tidak valid.' });
        }

        const { productId, variantSlug, count } = req.body;

        // Validasi input
        if (!productId || !variantSlug || !count) {
            return res.status(400).json({ error: 'Input tidak lengkap. Wajib ada: productId, variantSlug, dan count.' });
        }

        const numCount = parseInt(count, 10);
        if (isNaN(numCount) || numCount <= 0) {
            return res.status(400).json({ error: 'Count harus berupa angka positif.' });
        }

        // Cari produk di database
        const product = await Product.findOne({ id: productId });
        if (!product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan.' });
        }

        // Cari varian di dalam produk
        const variant = product.variants.find(v => v.slug === variantSlug);
        if (!variant) {
            return res.status(404).json({ error: 'Varian tidak ditemukan.' });
        }

        // Cek ketersediaan stok
        if (variant.stock.length < numCount) {
            return res.status(400).json({ 
                error: 'Stok tidak mencukupi.',
                available_stock: variant.stock.length 
            });
        }

        // Ambil sejumlah akun dari awal array dan hapus
        const takenStock = variant.stock.splice(0, numCount);

        // Simpan perubahan ke database
        await product.save();

        res.json({
            message: `Berhasil mengambil ${numCount} akun.`,
            taken_stock: takenStock,
            remaining_stock: variant.stock.length
        });

    } catch (error) {
        console.error("API Take Stock Error:", error);
        res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/return-stock', async (req, res) => {
    try {
        // Keamanan: wajib menyertakan kunci yang cocok dengan STOCK_API_KEY (.env).
        const kunci = req.headers['x-api-key'] || (req.body && req.body.api_key);
        if (!process.env.STOCK_API_KEY || kunci !== process.env.STOCK_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: API key tidak valid.' });
        }

        const { productId, variantSlug, stockItems } = req.body;

        // Validasi input
        if (!productId || !variantSlug || !stockItems) {
            return res.status(400).json({ error: 'Input tidak lengkap. Wajib ada: productId, variantSlug, dan stockItems.' });
        }

        if (!Array.isArray(stockItems) || stockItems.length === 0) {
            return res.status(400).json({ error: 'stockItems harus berupa array yang tidak kosong.' });
        }

        // Cari produk di database
        const product = await Product.findOne({ id: productId });
        if (!product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan.' });
        }

        // Cari varian di dalam produk
        const variant = product.variants.find(v => v.slug === variantSlug);
        if (!variant) {
            return res.status(404).json({ error: 'Varian tidak ditemukan.' });
        }

        // Tambahkan item stok kembali ke awal array stok
        variant.stock.unshift(...stockItems);

        // Simpan perubahan ke database
        await product.save();

        res.json({
            message: `Berhasil mengembalikan ${stockItems.length} akun.`,
            returned_stock: stockItems,
            current_stock: variant.stock.length
        });

    } catch (error) {
        console.error("API Return Stock Error:", error);
        res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
    }
});

app.get('/products/variants/delete/:id/:slug', authMiddleware, async (req, res) => {
    try {
        await Product.updateOne(
            { id: req.params.id }, 
            { $pull: { variants: { slug: req.params.slug } } }
        );
        res.redirect(`/products/manage/${req.params.id}`);
    } catch (error) {
        console.error("Error deleting variant:", error);
        res.redirect(`/products/manage/${req.params.id}?error=Failed to delete variant`);
    }
});
// --- Rute Utama Admin Panel ---

app.get('/', authMiddleware, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        // Sebelumnya menarik SEMUA order lunas (termasuk data akun) ke memori
        // hanya untuk dihitung & diambil 5 teratas. Sekarang dipisah.
        const paidOrdersCountValue = await Order.countDocuments({ status: 'PAID' });
        const paidOrders = await Order.find({ status: 'PAID' })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('amount paidAt productName variantName customerInfo')
            .lean();
        const products = await Product.find({});
        
        // HAPUS ATAU BERI KOMENTAR BARIS INI
        // const totalRevenue = paidOrders.reduce((sum, order) => sum + (order.amount || 0), 0);

        // TAMBAHKAN LOGIKA BARU UNTUK MENGAMBIL SALDO
        const linkquBalance = await linkqu.checkBalance();

        const totalStock = products.flatMap(p => p.variants).reduce((sum, v) => sum + (v.stock?.length || 0), 0);
        const recentTransactions = paidOrders;
        
        // UBAH CARA ANDA MENGIRIM DATA KE VIEW
        res.render('layout', {
            page: 'dashboard',
            body: await ejs.renderFile(path.join(__dirname, 'views/dashboard.ejs'), {
                revenue: linkquBalance, // <-- Ganti 'totalRevenue' menjadi 'revenue'
                revenueSource: 'Linkqu Balance', // <-- Tambahkan sumber pendapatan
                totalUsers, 
                totalStock,
                paidOrdersCount: paidOrdersCountValue,
                recentTransactions
            })
        });
    } catch (error) {
        console.error("Dashboard Error:", error);
        res.status(500).send("Error loading dashboard data.");
    }
});

app.get('/products', authMiddleware, async (req, res) => {
    const products = await Product.find({}).lean();
    products.forEach(p => {
        p.totalStock = p.variants.reduce((sum, v) => sum + (v.stock?.length || 0), 0);
    });
    res.render('layout', {
        page: 'products',
        body: await ejs.renderFile(path.join(__dirname, 'views/products.ejs'), { products, error: req.query.error, locals: { error: req.query.error } })
    });
});

app.post('/products/add', authMiddleware, async (req, res) => {
    try {
        const { id, name, description } = req.body;
        if (await Product.findOne({ id })) {
            return res.redirect('/products?error=Product ID already exists');
        }
        await new Product({ id, name, description, variants: [] }).save();
        res.redirect('/products');
    } catch (error) {
        res.redirect(`/products?error=${error.message}`);
    }
});

app.get('/products/manage/:id', authMiddleware, async (req, res) => {
    const product = await Product.findOne({ id: req.params.id }).lean();
    if (!product) return res.status(404).send('Product not found');
    // Simpan salinan stok SAAT halaman dibuka -> saat disimpan, hanya PERUBAHAN yang
    // diterapkan (akun yang terjual selama halaman terbuka tidak balik ke stok).
    req.session.stockSnap = req.session.stockSnap || {};
    for (const v of product.variants || []) {
        req.session.stockSnap[`${product.id}|${v.slug}`] = Array.isArray(v.stock) ? v.stock : [];
    }
    res.render('layout', {
        page: 'products',
        body: await ejs.renderFile(path.join(__dirname, 'views/manage-product.ejs'), { product })
    });
});

app.post('/products/edit/:id', authMiddleware, async (req, res) => {
    await Product.updateOne({ id: req.params.id }, { $set: { name: req.body.name, description: req.body.description } });
    res.redirect(`/products/manage/${req.params.id}`);
});

app.get('/products/delete/:id', authMiddleware, async (req, res) => {
    await Product.deleteOne({ id: req.params.id });
    res.redirect('/products');
});

app.post('/products/variants/add/:id', authMiddleware, async (req, res) => {
    const { name, slug, price } = req.body;
    const newVariant = { name, slug, price: parseInt(price, 10), stock: [], snk: "-" };
    await Product.updateOne({ id: req.params.id }, { $push: { variants: newVariant } });
    res.redirect(`/products/manage/${req.params.id}`);
});

app.post('/products/variants/edit/:id/:slug', authMiddleware, async (req, res) => {
    const { name, price, snk } = req.body;
    await Product.updateOne(
        { id: req.params.id, "variants.slug": req.params.slug },
        { $set: { "variants.$.name": name, "variants.$.price": parseInt(price, 10), "variants.$.snk": snk || "-" } }
    );
    res.redirect(`/products/manage/${req.params.id}`);
});

app.get('/products/variants/delete/:id/:slug', authMiddleware, async (req, res) => {
    await Product.updateOne({ id: req.params.id }, { $pull: { variants: { slug: req.params.slug } } });
    res.redirect(`/products/manage/${req.params.id}`);
});

app.post('/products/stock/update/:id/:slug', authMiddleware, async (req, res) => {
    const key = `${req.params.id}|${req.params.slug}`;
    const snap = req.session.stockSnap && req.session.stockSnap[key];
    if (!Array.isArray(snap)) {
        return res.status(409).send('Halaman stok sudah kedaluwarsa. Kembali, muat ulang halaman produk, lalu simpan lagi.');
    }
    const submitted = String(req.body.current_stock || '').split(/\r?\n/).filter(line => line.trim() !== '');
    // Hitung selisih (dengan memperhatikan duplikat) antara salinan awal & isi form.
    const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const before = count(snap);
    const after = count(submitted);
    const removed = [];
    const added = [];
    for (const [item, n] of before) if ((after.get(item) || 0) < n) removed.push(item);
    for (const [item, n] of after) for (let i = (before.get(item) || 0); i < n; i++) added.push(item);
    const filter = { id: req.params.id, "variants.slug": req.params.slug };
    if (removed.length) await Product.updateOne(filter, { $pull: { "variants.$.stock": { $in: removed } } });
    if (added.length) await Product.updateOne(filter, { $push: { "variants.$.stock": { $each: added } } });
    delete req.session.stockSnap[key];
    console.log(`[PANEL] Stok ${key}: +${added.length} / -${removed.length} (perubahan saja, stok terbaru tidak ditimpa).`);
    res.redirect(`/products/manage/${req.params.id}`);
});

app.post('/products/variants/bulk/:id/:slug', authMiddleware, async (req, res) => {
    const { min_quantity, price_per_item } = req.body;
    const min = parseInt(min_quantity, 10);
    const price = parseInt(price_per_item, 10);
    const update = (min && price)
        ? { $set: { "variants.$.bulk_pricing": { min_quantity: min, price_per_item: price } } }
        : { $unset: { "variants.$.bulk_pricing": "" } };
    await Product.updateOne({ id: req.params.id, "variants.slug": req.params.slug }, update);
    res.redirect(`/products/manage/${req.params.id}`);
});

app.get('/users', authMiddleware, async (req, res) => {
    const users = await User.find({}).lean();
    res.render('layout', {
        page: 'users',
        body: await ejs.renderFile(path.join(__dirname, 'views/users.ejs'), { users })
    });
});

app.get('/broadcast', authMiddleware, async (req, res) => {
    res.render('layout', {
        page: 'broadcast',
        body: await ejs.renderFile(path.join(__dirname, 'views/broadcast.ejs'), {
            success: req.query.success,
            error: req.query.error,
            locals: { success: req.query.success, error: req.query.error }
        })
    });
});

app.post('/broadcast/send', authMiddleware, upload.single('image_file'), async (req, res) => {
    const { broadcast_type, content, image_url, image_source } = req.body;
    try {
        const photo = (broadcast_type === 'image_with_text')
            ? ((image_source === 'url')
                ? image_url
                : { source: path.join(__dirname, 'public', 'uploads', req.file.filename) })
            : null;

        // Memakai mesin broadcast yang sama dengan bot: ada jeda antar kirim
        // (anti 429), fallback teks biasa kalau Markdown rusak, dan daftar
        // stok + tombol beli otomatis ikut terkirim.
        const result = await runBroadcast(bot.telegram, {
            text: content,
            photo,
            attachStock: true
        });

        if (req.file) {
            await fs.unlink(req.file.path).catch(() => {});
        }

        let summary = `Broadcast terkirim ke ${result.success} dari ${result.total} user.`;
        summary += ` Memblokir bot: ${result.blocked}. Gagal lain: ${result.failed}.`;
        if (result.stockAttached) summary += ' Daftar stok + tombol beli ikut terkirim.';
        if (result.markdownDisabled) summary += ' (Markdown tidak valid, dikirim sebagai teks biasa.)';
        res.redirect(`/broadcast?success=${encodeURIComponent(summary)}`);
    } catch (error) {
        console.error('Broadcast error:', error);
        res.redirect(`/broadcast?error=An error occurred during broadcast.`);
    }
});

// Nama file aset HANYA boleh file gambar yang sudah ada di folder assets (mis. welcome.png).
// Dulu nama dari form dipakai mentah -> "../views/login.ejs" bisa menimpa file server.
const ASSET_DIR = path.join(__dirname, 'assets');
const ASSET_TMP_DIR = path.join(__dirname, '.upload-tmp'); // di luar folder publik
const ASSET_ALLOWED = new Set(['welcome.png']); // aset yang boleh diganti dari panel
function safeAssetName(raw) {
    const name = String(raw || '');
    if (!name || path.basename(name) !== name) return null;          // tolak ../ dan folder
    if (!/^[\w.\- ]+\.(png|jpe?g|gif|webp)$/i.test(name)) return null;
    if (!ASSET_ALLOWED.has(name) && !require('fs').existsSync(path.join(ASSET_DIR, name))) return null;
    return name;
}
// File diunggah ke folder sementara dulu; baru dipindah ke assets kalau upload sukses,
// jadi upload gagal/terputus tidak merusak/menghapus gambar yang lama.
const assetStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        require('fs').mkdir(ASSET_TMP_DIR, { recursive: true }, (err) => cb(err || null, ASSET_TMP_DIR));
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.upload`)
});
const assetUpload = multer({ storage: assetStorage, limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/assets', authMiddleware, async (req, res) => {
    res.render('layout', {
        page: 'assets',
        body: await ejs.renderFile(path.join(__dirname, 'views/assets.ejs'), {
            success: req.query.success, error: req.query.error, locals: { success: req.query.success, error: req.query.error }
        })
    });
});

app.post('/assets/replace', authMiddleware, (req, res) => {
    assetUpload.single('new_image_file')(req, res, async (err) => {
        if (err) return res.redirect('/assets?error=' + encodeURIComponent('Gagal mengganti aset: ' + err.message));
        if (!req.file) {
            return res.redirect('/assets?error=You did not select a file to upload.');
        }
        const name = safeAssetName(req.body.asset_to_replace);
        if (!name) {
            await fs.unlink(req.file.path).catch(() => {});
            return res.redirect('/assets?error=' + encodeURIComponent('Nama aset tidak valid.'));
        }
        try {
            await fs.rename(req.file.path, path.join(ASSET_DIR, name));
        } catch (e) {
            await fs.unlink(req.file.path).catch(() => {});
            return res.redirect('/assets?error=' + encodeURIComponent('Gagal menyimpan aset: ' + e.message));
        }
        res.redirect(`/assets?success=${encodeURIComponent('Successfully replaced ' + name)}`);
    });
});

// Halaman "Pembeli DO": daftar pembeli DigitalOcean + template pindah bot.
pembeliDo.registerRoutes(app, authMiddleware, ejs, path, path.join(__dirname, 'views'));

app.get('/payment-gateways', authMiddleware, async (req, res) => {
    try {
        let settings = await Settings.findOneAndUpdate(
            { identifier: 'global-settings' },
            { $setOnInsert: { identifier: 'global-settings' } },
            { new: true, upsert: true }
        ).lean();
        res.render('layout', {
            page: 'payment-gateways',
            body: await ejs.renderFile(path.join(__dirname, 'views/payment-gateways.ejs'), {
                settings,
                success: req.query.success,
                locals: { success: req.query.success }
            })
        });
    } catch (error) {
        console.error("Payment Gateway Page Error:", error);
        res.status(500).send("Error loading payment gateway settings.");
    }
});

app.post('/payment-gateways/save', authMiddleware, async (req, res) => {
    try {
        const { linkqu_enabled, dana_enabled, tokopay_enabled } = req.body;
        const settingsUpdate = {
            linkqu_enabled: !!linkqu_enabled,
            dana_enabled: !!dana_enabled,
            tokopay_enabled: !!tokopay_enabled
        };
        await Settings.updateOne({ identifier: 'global-settings' }, settingsUpdate, { upsert: true });
        res.redirect('/payment-gateways?success=Settings updated successfully!');
    } catch (error) {
        console.error("Save Payment Settings Error:", error);
        res.status(500).send("Error saving settings.");
    }
});

app.get('/api-docs', authMiddleware, async (req, res) => {
    try {
        res.render('layout', {
            page: 'api-docs', // Untuk menyorot link aktif di sidebar
            body: await ejs.renderFile(path.join(__dirname, 'views/api-docs.ejs'), {
                locals: {}
            })
        });
    } catch (error) {
        console.error("API Docs Page Error:", error);
        res.status(500).send("Error loading API documentation.");
    }
});
// =================================================================
// BAGIAN B: KODE TELEGRAM BOT (DARI bot.js)
// =================================================================

// Wajib join channel testimoni sebelum memakai bot (owner dikecualikan).
// Bot harus ADMIN di channel. Atur lewat env FORCE_JOIN_CHANNEL (isi "off" untuk mematikan).
const createForceJoin = require('./forcejoin');
createForceJoin({
    channel: process.env.TESTI_CHANNEL !== undefined ? process.env.TESTI_CHANNEL : '@testiAlimStore',
    storeName: 'ALIM STORE',
}).attach(bot);

pembeliDo.attach(bot);

adminModule(bot);

// === HELPER: escape karakter spesial Markdown (legacy) ===
// FIX BUG: nama/username Telegram yang mengandung _ * ` [ ] membuat Telegram
// menolak seluruh pesan ("can't parse entities") sehingga /start gagal.
function escapeMd(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/([_*`\[])/g, '\\$1');
}

// === HELPER: pastikan dokumen user SELALU ada ===
// FIX BUG UTAMA: customer baru bisa belum punya dokumen di DB (upsert gagal,
// race saat /start ditekan cepat 2x, atau error transient). Fungsi ini
// idempotent dan aman terhadap duplicate key (E11000).
async function ensureUser(from) {
    const userId = from.id.toString();
    const username = from.username || 'N/A';
    try {
        const user = await User.findOneAndUpdate(
            { id: userId },
            {
                $set: { username },
                $setOnInsert: { balance: 0, totalSpent: 0 }
            },
            // setDefaultsOnInsert sengaja DIMATIKAN: nilai awal sudah ditulis
            // eksplisit di $setOnInsert, jadi tidak ada dua sumber yang bisa
            // bentrok di path yang sama.
            { upsert: true, new: true, setDefaultsOnInsert: false }
        ).lean();
        if (user) {
            // Jaring pengaman: pastikan field `id` benar-benar tersimpan.
            if (!user.id) {
                await User.updateOne({ _id: user._id }, { $set: { id: userId } });
                user.id = userId;
            }
            return user;
        }
    } catch (error) {
        // Race condition: dua update masuk bersamaan -> salah satu duplicate key.
        if (error && (error.code === 11000 || error.code === 11001)) {
            const existing = await User.findOne({ id: userId }).lean();
            if (existing) return existing;
        } else {
            console.error('ensureUser error:', error.message);
        }
    }
    // Fallback in-memory supaya /start TIDAK PERNAH crash walau DB bermasalah.
    return { id: userId, username, balance: 0, totalSpent: 0 };
}

bot.use(async (ctx, next) => {
    //console.log(JSON.stringify(ctx.update, null, 2));
    if (ctx.from && !ctx.from.is_bot) {
        try {
            ctx.state.user = await ensureUser(ctx.from);
        } catch (error) {
            console.error("Error in user middleware:", error);
        }
    }
    await next();
});

async function findProductAndVariant(productId, variantSlug) {
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) return { product: null, variant: null };
    const variant = product.variants.find(v => v.slug === variantSlug);
    if (!variant) return { product, variant: null };
    variant.stockCount = variant.stock?.length || 0;
    return { product, variant };
}

async function generateStartMessageAndKeyboard(ctx) {
    const userId = ctx.from.id.toString();
    // FIX BUG: sebelumnya `User.findOne(...)` mengembalikan null untuk customer
    // baru, lalu `user.totalSpent` melempar TypeError -> muncul pesan
    // "Terjadi kesalahan saat memulai bot". Sekarang user dijamin ada.
    const user = ctx.state.user || await ensureUser(ctx.from);
    const totalUsers = await User.countDocuments();
    const productsSoldCountResult = await Order.aggregate([
        { $match: { status: 'PAID' } },
        { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]);
    const productsSoldCount = productsSoldCountResult[0]?.total || 0;

    const totalSpentRp = (user.totalSpent || 0).toLocaleString('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
    const balanceRp = (user.balance || 0).toLocaleString('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });

    // FIX BUG: nama & username di-escape agar tidak merusak parsing Markdown.
    const displayName = escapeMd(ctx.from.first_name || 'User');
    const displayUsername = escapeMd(user.username || ctx.from.username || 'N/A');

    const message = `👋 — Hello ${displayName} Selamat Datang Di ALIM STORE\n\n` +
                    `🗓️ ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n` +
                    `*User Details :*\n` +
                    `├ ID : \`${userId}\`\n` +
                    `├ Username : @${displayUsername}\n` +
                    `└ Total Spent : ${totalSpentRp}\n\n` +
                    `*BOT Statistics*\n\n` +
                    `├ Products Sold : ${9132 + productsSoldCount} Accounts\n` +
                    `└ Total Users : ${1087 + totalUsers} Users\n\n` +
                    `Silahkan tekan tombol '🛒 List Produk'\n` +
                    `Bot Ubah Vps Ke Rdp (installer rdp) @fzistorebot\n`;

    // FIX BUG: OWNER_ID yang belum diset membuat .split() melempar TypeError.
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    const isAdmin = ADMIN_IDS.includes(userId);
    const keyboardLayout = [['🛒 List Produk', '🧾 Riwayat Transaksi'], ['📦 Cek Stok']];
    if (isAdmin) keyboardLayout.push(['⚙️ Admin Panel']);

    // Tombol INLINE di bawah teks /start (mirip tombol pada /stock), biar
    // customer bisa langsung tekan tanpa mengetik. Memakai action yang ada:
    // list_products_1, show_stock, show_history, open_admin.
    const inlineRows = [
        [
            Markup.button.callback('🛒 Lihat Produk', 'list_products_1'),
            Markup.button.callback('📦 Cek Stok', 'show_stock'),
        ],
        [Markup.button.callback('🧾 Riwayat Transaksi', 'show_history')],
        [Markup.button.url('📝 Pesan Manual (PO)', PO_WA_URL)],
    ];
    if (isAdmin) inlineRows.push([Markup.button.callback('⚙️ Admin Panel', 'open_admin')]);

    return {
        message,
        keyboard: Markup.keyboard(keyboardLayout).resize(),
        inlineKeyboard: Markup.inlineKeyboard(inlineRows),
    };
}

async function generateProductListMessageAndKeyboard(page = 1) {
    const productsPerPage = 10;
    const totalProducts = await Product.countDocuments();
    const totalPages = Math.ceil(totalProducts / productsPerPage);
    const products = await Product.find({}).sort({ name: 1 }).skip((page - 1) * productsPerPage).limit(productsPerPage).lean();

    let message = `*LIST PRODUK*\nPage ${page}/${totalPages}\n────────────✧\n`;
    const keyboardButtons = [];

    if (products.length === 0) {
        message += "Tidak ada produk yang tersedia.";
    } else {
        products.forEach((p, index) => {
            const productNumber = (page - 1) * productsPerPage + index + 1;
            const variants = Array.isArray(p.variants) ? p.variants : [];
            const totalStock = variants.reduce((sum, v) => sum + (Array.isArray(v.stock) ? v.stock.length : 0), 0);
            const stockEmoji = totalStock > 0 ? '✅' : '❌';
            message += `${stockEmoji} *[${productNumber}]* ${escapeMd(String(p.name || '-').toUpperCase())} → x${totalStock}\n`;
            keyboardButtons.push(Markup.button.callback(`${productNumber}`, `show_product_${p.id}_page_${page}`));
        });
    }
    
    message += `────────────✧`;
    message += `\n_Pilih produk dengan menekan tombol angka yang sesuai._`;
    
    const chunkedKeyboard = [];
    for (let i = 0; i < keyboardButtons.length; i += 5) {
        chunkedKeyboard.push(keyboardButtons.slice(i, i + 5));
    }

    const navButtons = [];
    if (page > 1) navButtons.push(Markup.button.callback('⬅️ Prev', `list_products_${page - 1}`));
    if (page < totalPages) navButtons.push(Markup.button.callback('Next ➡️', `list_products_${page + 1}`));

    const keyboard = Markup.inlineKeyboard([
        ...chunkedKeyboard,
        navButtons,
        [Markup.button.url('📝 Pesan Manual (PO)', PO_WA_URL)],
        [Markup.button.callback('⬅️ Back to Home', 'back_to_start')]
    ]);

    return { message, keyboard };
}

// BARU: /stock kini mengembalikan pesan + INLINE KEYBOARD daftar produk,
// sehingga customer bisa langsung menekan nomor produk untuk melihat detail
// dan membeli tanpa harus membuka menu 'List Produk' lagi.
async function generateStockMessageAndKeyboard() {
    const products = await Product.find({}).sort({ name: 1 }).lean();
    let message = `🛒 *Informasi Stok*\n- Tanggal: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n────────────✧\n`;
    const productButtons = [];

    if (!products || products.length === 0) {
        message += 'Saat ini belum ada produk yang tersedia.';
    } else {
        products.forEach((p, index) => {
            const variants = Array.isArray(p.variants) ? p.variants : [];
            const totalStock = variants.reduce((sum, v) => sum + (Array.isArray(v.stock) ? v.stock.length : 0), 0);
            const stockEmoji = totalStock > 0 ? '✅' : '❌';
            const productNumber = index + 1;
            // FIX BUG: nama produk di-escape agar karakter _ * ` [ ] tidak
            // merusak parsing Markdown (pesan gagal terkirim).
            message += `${stockEmoji} *[${productNumber}]* ${escapeMd(String(p.name || '-').toUpperCase())} → x${totalStock}\n`;
            // Batas aman inline keyboard Telegram (maks 100 tombol / pesan).
            if (productButtons.length < 50) {
                productButtons.push(Markup.button.callback(`${productNumber}`, `show_product_${p.id}_page_1`));
            }
        });
        message += `────────────✧\n`;
        message += `_Tekan tombol angka di bawah untuk melihat detail varian & membeli._`;
    }

    const chunkedButtons = [];
    for (let i = 0; i < productButtons.length; i += 5) {
        chunkedButtons.push(productButtons.slice(i, i + 5));
    }

    const keyboard = Markup.inlineKeyboard([
        ...chunkedButtons,
        [
            Markup.button.callback('🔄 Refresh Stok', 'refresh_stock'),
            Markup.button.callback('🛒 List Produk', 'list_products_1')
        ]
    ]);

    return { message, keyboard };
}

// Dipertahankan untuk kompatibilitas (kalau ada pemanggil lain).
async function generateStockTextMessage() {
    const { message } = await generateStockMessageAndKeyboard();
    return message;
}

// =============================================================
// MESIN BROADCAST
// =============================================================
// Telegram membatasi bot ~30 pesan/detik untuk pengiriman massal. Loop lama
// mengirim tanpa jeda sama sekali sehingga kena 429 (Too Many Requests), dan
// error itu merembet ke pesan status di akhir -> muncul "Terjadi kesalahan"
// padahal pesannya sendiri sudah terkirim.
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '40', 10);
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

const broadcastSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dipakai saat Markdown terpaksa dimatikan: buang penanda format supaya user
// tidak melihat bintang dan backtick mentah di pesannya.
function toPlainText(text) {
    return String(text || '')
        .replace(/\\([_*`\[\]])/g, '$1')
        .replace(/[*`]/g, '');
}

// Telegraf menaruh detail error di tempat berbeda tergantung versi.
function telegramErrorInfo(error) {
    const response = (error && error.response) || {};
    const parameters = response.parameters || (error && error.parameters) || {};
    return {
        code: response.error_code || (error && error.code),
        description: String(response.description || (error && error.description) || (error && error.message) || ''),
        retryAfter: parameters.retry_after
    };
}

// Kirim satu pesan dengan penanganan 429 (tunggu sesuai perintah Telegram)
// dan Markdown rusak (kirim ulang sebagai teks biasa).
async function sendWithRetry(chatId, sendFn, state) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await sendFn(state.useMarkdown);
            return { ok: true };
        } catch (error) {
            const info = telegramErrorInfo(error);

            // 429: Telegram memberi tahu harus menunggu berapa detik.
            if (info.code === 429 && info.retryAfter) {
                await broadcastSleep((info.retryAfter + 1) * 1000);
                continue;
            }
            // Markdown admin tidak valid -> matikan Markdown untuk sisa broadcast
            // supaya pesan tetap sampai, bukan gagal semua.
            if (info.description.includes('parse entities') && state.useMarkdown) {
                state.useMarkdown = false;
                state.markdownDisabled = true;
                continue;
            }
            // User memblokir bot / akun dihapus: kegagalan permanen, bukan error.
            if (info.code === 403 ||
                info.description.includes('bot was blocked') ||
                info.description.includes('user is deactivated') ||
                info.description.includes('chat not found')) {
                return { ok: false, blocked: true };
            }
            return { ok: false, error: info.description };
        }
    }
    return { ok: false, error: 'gagal setelah percobaan ulang' };
}

// Jalankan broadcast ke semua user, lengkap dengan daftar stok + tombol beli.
// Mengembalikan ringkasan; TIDAK pernah melempar error ke pemanggil.
async function runBroadcast(telegram, options) {
    const opts = options || {};
    const text = opts.text || '';
    const photo = opts.photo || null;
    const attachStock = opts.attachStock !== false;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const result = {
        total: 0, success: 0, failed: 0, blocked: 0,
        markdownDisabled: false, stockAttached: false
    };

    // Daftar stok dihitung SEKALI saja, bukan per user.
    let stockMessage = null;
    let stockKeyboard = null;
    if (attachStock) {
        try {
            const stock = await generateStockMessageAndKeyboard();
            stockMessage = stock.message;
            stockKeyboard = stock.keyboard;
            result.stockAttached = true;
        } catch (error) {
            console.error('Broadcast: gagal memuat daftar stok:', error.message);
        }
    }

    // Kalau muat, gabungkan jadi SATU pesan supaya user tidak dapat 2 notifikasi.
    const combined = (text && stockMessage) ? (text + '\n\n' + stockMessage) : null;
    const canCombine = !photo && combined !== null && combined.length <= TELEGRAM_TEXT_LIMIT - 96;

    const users = await User.find({ id: { $exists: true, $ne: null } }, 'id').lean();
    const userIds = users.map((u) => u.id).filter(Boolean);
    result.total = userIds.length;

    const state = { useMarkdown: true, markdownDisabled: false };

    for (let i = 0; i < userIds.length; i++) {
        const chatId = userIds[i];
        let delivered = false;
        let blocked = false;

        // --- Pesan utama ---
        if (photo) {
            const caption = text.length > TELEGRAM_CAPTION_LIMIT
                ? text.slice(0, TELEGRAM_CAPTION_LIMIT - 1)
                : text;
            const outcome = await sendWithRetry(chatId, (useMarkdown) =>
                telegram.sendPhoto(chatId, photo, useMarkdown
                    ? { caption, parse_mode: 'Markdown' }
                    : { caption: toPlainText(caption) }), state);
            delivered = outcome.ok;
            blocked = !!outcome.blocked;
        } else {
            const body = canCombine ? combined : text;
            const extra = (canCombine && stockKeyboard)
                ? { reply_markup: stockKeyboard.reply_markup }
                : {};
            const outcome = await sendWithRetry(chatId, (useMarkdown) =>
                telegram.sendMessage(chatId, useMarkdown ? body : toPlainText(body), useMarkdown
                    ? Object.assign({ parse_mode: 'Markdown' }, extra)
                    : Object.assign({}, extra)), state);
            delivered = outcome.ok;
            blocked = !!outcome.blocked;
        }

        // --- Daftar stok sebagai pesan kedua (kalau tidak muat digabung) ---
        if (delivered && stockMessage && !canCombine) {
            await broadcastSleep(BROADCAST_DELAY_MS);
            await sendWithRetry(chatId, (useMarkdown) =>
                telegram.sendMessage(chatId, useMarkdown ? stockMessage : toPlainText(stockMessage), useMarkdown
                    ? { parse_mode: 'Markdown', reply_markup: stockKeyboard.reply_markup }
                    : { reply_markup: stockKeyboard.reply_markup }), state);
        }

        if (delivered) result.success += 1;
        else if (blocked) result.blocked += 1;
        else result.failed += 1;

        if (onProgress && (i + 1) % 50 === 0) {
            try { await onProgress(i + 1, result); } catch (e) {}
        }

        // Jeda antar user: inilah yang mencegah 429.
        if (i < userIds.length - 1) await broadcastSleep(BROADCAST_DELAY_MS);
    }

    result.markdownDisabled = state.markdownDisabled;
    return result;
}

function formatBroadcastSummary(result) {
    let summary = `🚀 *Broadcast Selesai*\n\n` +
        `✅ Berhasil terkirim: ${result.success} pengguna\n` +
        `🚫 Memblokir bot / akun hilang: ${result.blocked} pengguna\n` +
        `❌ Gagal lain: ${result.failed} pengguna\n` +
        `👥 Total user: ${result.total}`;
    if (result.stockAttached) {
        summary += `\n\n📦 Daftar stok + tombol beli ikut terkirim.`;
    }
    if (result.markdownDisabled) {
        summary += `\n\n⚠️ Format Markdown pesanmu tidak valid, jadi pesan dikirim sebagai teks biasa.`;
    }
    return summary;
}

async function generateProductDetailsMessageAndKeyboard(productId, page) {
    try {
        const product = await Product.findOne({ id: productId }).lean();

        if (!product) {
            return { 
                message: '❌ Produk tidak ditemukan.', 
                keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `list_products_${page}`)]) 
            };
        }
        
        const descriptionText = (product.description && product.description.trim() !== '-') 
            ? product.description 
            : '_Tidak ada deskripsi untuk produk ini._';

        let message = `📦 *Detail Produk: ${escapeMd(String(product.name || '-').toUpperCase())}*\n` +
                      `*Deskripsi:*\n${descriptionText}\n` +
                      `────────────✧\n` +
                      `*Pilih Varian Tersedia:*\n`;

        const variantButtons = [];
        product.variants.forEach(v => {
            const stockCount = (Array.isArray(v.stock) ? v.stock.length : 0);
            const stockEmoji = stockCount > 0 ? '✅' : '❌';
            const stockStatus = stockCount > 0 ? `Stok: ${stockCount}` : 'Stok: Habis';
            
            message += `\n${stockEmoji} *${escapeMd(v.name)}*\n`;
            message += `   ↳ Harga: Rp ${v.price.toLocaleString('id-ID')} - *${stockStatus}*\n`;
            
            if (v.bulk_pricing?.min_quantity > 0) {
                 message += `   ↳ Grosir: Beli min ${v.bulk_pricing.min_quantity} @ Rp ${v.bulk_pricing.price_per_item.toLocaleString('id-ID')}\n`;
            }

            if (stockCount > 0) {
                variantButtons.push(Markup.button.callback(`Beli ${v.name} (Rp ${v.price.toLocaleString('id-ID')})`, `buy_qty_${product.id}_${v.slug}_1_page_${page}`));
            }
        });

        message += `\n────────────✧`;

        // === PERUBAHAN POSISI DI SINI ===
        // Pesan ajakan sekarang berada di paling bawah
        if (variantButtons.length > 0) {
            message += `\n_Silakan pilih varian di atas dengan menekan tombol 'Beli'._`;
        }
        
        const chunkedVariantButtons = [];
        for (let i = 0; i < variantButtons.length; i += 2) {
            chunkedVariantButtons.push(variantButtons.slice(i, i + 2));
        }

        const keyboard = [
            ...chunkedVariantButtons,
            [Markup.button.callback('⬅️ Kembali', `list_products_${page}`)]
        ];

        return { message, keyboard: Markup.inlineKeyboard(keyboard) };
    } catch (error) {
        console.error('Error in generateProductDetailsMessageAndKeyboard:', error);
        return { 
            message: '❌ Terjadi kesalahan saat memuat detail produk.', 
            keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `list_products_${page}`)]) 
        };
    }
}

async function generateQuantityMessageAndKeyboard(productId, variantSlug, quantity, page) {
    const { product, variant } = await findProductAndVariant(productId, variantSlug);
    if (!product || !variant) {
        return { message: '❌ Produk atau varian tidak ditemukan.', keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `list_products_${page}`)]) };
    }

    let hargaPerPcs = variant.price;
    let hargaNormal = quantity * variant.price;
    let totalHarga = hargaNormal;
    let discountMessage = '';

    if (variant.bulk_pricing && quantity >= variant.bulk_pricing.min_quantity) {
        hargaPerPcs = variant.bulk_pricing.price_per_item;
        totalHarga = quantity * hargaPerPcs;
        discountMessage = `\n🎉 *Harga grosir aktif!* (Rp ${hargaPerPcs.toLocaleString('id-ID')}/pcs)`;
    }

    const maxStock = variant.stockCount;

    let message = `🛍️ *Konfirmasi Pesanan Anda*\n\n` +
                  `Berikut adalah rincian pesanan Anda:\n` +
                  `────────────✧\n` +
                  `*– Produk: ${product.name}*\n` +
                  `*– Varian: ${variant.name}*\n` +
                  `*– Jumlah: ${quantity}*\n\n` +
                  (discountMessage ? `💵 *Harga Normal:* ~Rp ${hargaNormal.toLocaleString('id-ID')}~\n` : '') +
                  `💵 *Total Harga:* Rp ${totalHarga.toLocaleString('id-ID')}` +
                  `${discountMessage}\n` +
                  `────────────✧\n` +
                  `_Pilih jumlah pembelian dengan menekan tombol angka di bawah. Butuh lebih dari 10? Tekan "Custom"._`;

    // ==== TOMBOL ANGKA LANGSUNG (1..10) + CUSTOM ====
    // Pola callback: qty_set:{productId}:{variantSlug}:{qty}:{page}
    const keyboard = [];
    const maxButton = Math.min(10, maxStock);   // tampilkan angka sampai 10 atau sebatas stok
    const numberButtons = [];
    for (let n = 1; n <= maxButton; n++) {
        const label = (n === quantity) ? `✅ ${n}` : `${n}`; // tandai jumlah yang sedang dipilih
        numberButtons.push(Markup.button.callback(label, `qty_set:${productId}:${variantSlug}:${n}:${page}`));
    }
    // Susun 5 tombol per baris agar rapi
    for (let i = 0; i < numberButtons.length; i += 5) {
        keyboard.push(numberButtons.slice(i, i + 5));
    }

    // Tombol Custom hanya berguna jika stok > 10 (untuk jumlah di luar 1-10)
    if (maxStock > 10) {
        const customLabel = (quantity > 10) ? `✍️ Custom (${quantity})` : `✍️ Custom`;
        keyboard.push([Markup.button.callback(customLabel, `qty_custom:${productId}:${variantSlug}:${page}`)]);
    }

    keyboard.push([Markup.button.callback('Lanjutkan ke Pembayaran ➡️', `proceed_payment:${productId}:${variantSlug}:${quantity}:${page}`)]);
    keyboard.push([Markup.button.callback('🔄 Kembali', `back_to_details_${productId}_page_${page}`)]);

    return { message, keyboard: Markup.inlineKeyboard(keyboard) };
}

async function generatePaymentMessageAndKeyboard(productId, variantSlug, quantity, page) {
    const { product, variant } = await findProductAndVariant(productId, variantSlug);
    if (!product || !variant) {
        return { message: '❌ Produk atau varian tidak ditemukan.', keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `list_products_${page}`)]) };
    }

    let hargaPerPcs = variant.price;
    if (variant.bulk_pricing && quantity >= variant.bulk_pricing.min_quantity) {
        hargaPerPcs = variant.bulk_pricing.price_per_item;
    }
    const totalHarga = quantity * hargaPerPcs;

    const message = `💳 *Rincian Pembayaran*` +
                    `\n────────────✧\n` +
                    `*– Nama Produk:* ${product.name}\n` +
                    `*– Varian:* ${variant.name}\n` +
                    `*– Jumlah:* ${quantity}\n` +
                    `*– Total Harga:* Rp ${totalHarga.toLocaleString('id-ID')}` +
                    `\n────────────✧\n` +
                    `_Pilih metode pembayaran:_` ;
    
    const settings = await Settings.findOne({ identifier: 'global-settings' }).lean() || { linkqu_enabled: true, dana_enabled: true, tokopay_enabled: true };

    const keyboardRows = [];
    //const row1 = [];
    const row2 = [];

    //if (settings.linkqu_enabled) {
        //row1.push(Markup.button.callback('QRIS (ALL)', `qris_${productId}_${variantSlug}_${quantity}`));
    //}
    //if (settings.dana_enabled) {
        //row1.push(Markup.button.callback('DANA', `dana_${productId}_${variantSlug}_${quantity}`));
    //}
    if (settings.tokopay_enabled) {
        row2.push(Markup.button.callback('QRIS (ALL)', `tokopay_${productId}_${variantSlug}_${quantity}`));
    }

    //if (row1.length > 0) keyboardRows.push(row1);
    if (row2.length > 0) keyboardRows.push(row2);
    
    keyboardRows.push([Markup.button.callback('⬅️ Kembali', `back_to_qty_${productId}_${variantSlug}_${quantity}_page_${page}`)]);

    return { message, keyboard: Markup.inlineKeyboard(keyboardRows) };
}

bot.start(async (ctx) => {
    try {
        const { message, keyboard, inlineKeyboard } = await generateStartMessageAndKeyboard(ctx);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        // FIX BUG: kalau assets/welcome.png hilang, replyWithPhoto melempar
        // error dan customer hanya melihat "Terjadi kesalahan saat memulai bot".
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);

        // Set dulu keyboard bawah (reply keyboard) lewat pesan kecil, lalu kirim
        // pesan utama berisi tombol INLINE (Lihat Produk / Cek Stok / Riwayat).
        // Dengan begitu customer punya DUA-duanya: menu bawah + tombol inline.
        await ctx.reply('🏠 Menu utama:', { reply_markup: keyboard.reply_markup }).catch(() => {});

        if (fileExists) {
            // Tombol inline dilampirkan langsung ke pesan foto welcome.
            await ctx.replyWithPhoto(
                { source: imagePath },
                {
                    caption: message,
                    parse_mode: 'Markdown',
                    reply_markup: inlineKeyboard.reply_markup
                }
            );
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        }

    } catch (error) {
        console.error('Error in /start:', error);
        // Fallback terakhir: kirim tanpa Markdown supaya user tetap dapat menu.
        try {
            const { message, inlineKeyboard } = await generateStartMessageAndKeyboard(ctx);
            const plain = message
                .replace(/\\([_*`\[\]])/g, '$1')  // buang backslash hasil escapeMd
                .replace(/[*`]/g, '');
            await ctx.reply(plain, { reply_markup: inlineKeyboard.reply_markup });
        } catch (fallbackError) {
            console.error('Error in /start fallback:', fallbackError);
            await ctx.reply('❌ Terjadi kesalahan saat memulai bot.');
        }
    }
});

// Aksi INLINE untuk tombol pada /start (mirror tombol menu bawah).
bot.action('show_stock', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const { message, keyboard } = await generateStockMessageAndKeyboard();
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (error) {
        console.error('Error in show_stock:', error);
        try { await ctx.answerCbQuery('❌ Gagal memuat stok.', { show_alert: true }); } catch (e) {}
    }
});

bot.action('show_history', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const userPaidOrders = await Order.find({ "customerInfo.telegramUserId": userId, status: 'PAID' }).lean();
        if (userPaidOrders.length === 0) {
            return ctx.reply('Anda belum memiliki riwayat transaksi yang berhasil.');
        }
        const purchaseSummary = {};
        userPaidOrders.forEach(order => {
            const key = `${order.productName} ${order.variantName}`;
            purchaseSummary[key] = (purchaseSummary[key] || 0) + order.quantity;
        });
        let message = `📋 *RIWAYAT PEMBELIAN ANDA*\nTotal Transaksi Berhasil: ${userPaidOrders.length}\n────────────✧\n`;
        Object.entries(purchaseSummary).forEach(([itemName, qty], index) => {
            message += `${index + 1}. ${itemName} x ${qty}\n`;
        });
        message += `────────────✧`;
        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in show_history:', error);
        await ctx.reply('❌ Gagal mengambil riwayat transaksi.');
    }
});

bot.action('open_admin', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
        if (!ADMIN_IDS.includes(ctx.from.id.toString())) {
            return ctx.answerCbQuery('Menu ini hanya untuk admin.', { show_alert: true }).catch(() => {});
        }
        const { message, keyboard } = await adminModule.getAdminMenuMessageAndKeyboard();
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (error) {
        console.error('Error in open_admin:', error);
        await ctx.reply('❌ Terjadi kesalahan saat membuka panel admin.');
    }
});

bot.action(/^list_products_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const page = parseInt(ctx.match[1]);
        const { message, keyboard } = await generateProductListMessageAndKeyboard(page);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);

        if (fileExists) {
            if (ctx.callbackQuery.message.photo) {
                await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            } else {
                // Bot hanya boleh menghapus pesannya sendiri dalam 48 jam.
                // Pesan broadcast lama akan gagal dihapus -> jangan sampai
                // itu membuat tombolnya mati.
                await ctx.deleteMessage().catch(() => {});
                await ctx.replyWithPhoto(
                    { source: imagePath },
                    { caption: message, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
            }
        } else {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in list_products:', error);
    }
});

bot.action('back_to_start', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const { message, keyboard } = await generateStartMessageAndKeyboard(ctx);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);

        await ctx.deleteMessage();
        if (fileExists) {
            await ctx.replyWithPhoto(
                { source: imagePath },
                { caption: message, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in back_to_start:', error);
    }
});

bot.action(/^show_product_([^_]+)_page_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const page = parseInt(ctx.match[2]);
        const { message, keyboard } = await generateProductDetailsMessageAndKeyboard(productId, page);

        try {
            if (ctx.callbackQuery.message.photo) {
                await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            } else {
                await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            }
        } catch (editError) {
            // Pesan broadcast bisa saja sudah tidak bisa diedit (terlalu lama /
            // sudah dihapus). Jangan biarkan tombolnya terasa mati: kirim
            // pesan baru saja.
            const info = telegramErrorInfo(editError);
            if (info.description.includes('message is not modified')) return;
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in show_product_details:', error);
        try { await ctx.answerCbQuery('❌ Gagal memuat produk.', { show_alert: true }); } catch (e) {}
    }
});

bot.action(/^buy_qty_([^_]+)_(.*?)_(\d+)_page_(\d+)$/, async (ctx) => {
    try {
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const quantity = parseInt(ctx.match[3]);
        const page = parseInt(ctx.match[4]);

        const { variant } = await findProductAndVariant(productId, variantSlug);

        if (!variant || variant.stockCount === 0) {
            await ctx.answerCbQuery('STOK KOSONG, SILAHKAN PILIH VARIANT LAIN', { show_alert: true });
            return;
        }
        await ctx.answerCbQuery();

        const { message, keyboard } = await generateQuantityMessageAndKeyboard(productId, variantSlug, quantity, page);

        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        } else {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in buy_qty:', error);
    }
});

bot.action(/^qty_mod:([^:]+):(.+):(-?\d+):(\d+):(\d+)$/, async (ctx) => {
    try {
        const [, productId, variantSlug, changeAmountStr, currentQtyStr, pageStr] = ctx.match;
        // ... (sisa isi fungsi ini sama persis seperti sebelumnya, tidak perlu diubah)
        const changeAmount = parseInt(changeAmountStr, 10);
        const currentQty = parseInt(currentQtyStr, 10);
        const page = parseInt(pageStr, 10);

        let newQty = currentQty + changeAmount;

        const { variant } = await findProductAndVariant(productId, variantSlug);
        if (!variant) {
            return await ctx.answerCbQuery('❌ Varian produk tidak ditemukan.', { show_alert: true });
        }

        const maxStock = variant.stock.length;

        if (newQty < 1) newQty = 1;
        if (newQty > maxStock) {
            await ctx.answerCbQuery(`⚠️ Stok tidak mencukupi. Sisa stok: ${maxStock}`, { show_alert: false });
            newQty = maxStock;
        }

        if (newQty !== currentQty) {
            await ctx.answerCbQuery();
            const { message, keyboard } = await generateQuantityMessageAndKeyboard(productId, variantSlug, newQty, page);

            try {
                await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            } catch (e) {
                if (!e.message.includes('message is not modified')) {
                    console.error('Error updating quantity message:', e);
                }
            }
        } else {
            await ctx.answerCbQuery();
        }
    } catch (error) {
        console.error('Error in qty_mod buttons:', error);
        await ctx.answerCbQuery('❌ Terjadi kesalahan saat mengubah jumlah.', { show_alert: true });
    }
});

// ==== PILIH JUMLAH LANGSUNG lewat tombol angka: qty_set:{productId}:{variantSlug}:{qty}:{page} ====
bot.action(/^qty_set:([^:]+):(.+):(\d+):(\d+)$/, async (ctx) => {
    try {
        const [, productId, variantSlug, qtyStr, pageStr] = ctx.match;
        let newQty = parseInt(qtyStr, 10);
        const page = parseInt(pageStr, 10);

        const { variant } = await findProductAndVariant(productId, variantSlug);
        if (!variant) {
            return await ctx.answerCbQuery('❌ Varian produk tidak ditemukan.', { show_alert: true });
        }

        const maxStock = variant.stock.length;
        if (newQty < 1) newQty = 1;
        if (newQty > maxStock) {
            await ctx.answerCbQuery(`⚠️ Stok tidak mencukupi. Sisa stok: ${maxStock}`, { show_alert: true });
            newQty = maxStock;
        } else {
            await ctx.answerCbQuery();
        }

        const { message, keyboard } = await generateQuantityMessageAndKeyboard(productId, variantSlug, newQty, page);
        try {
            if (ctx.callbackQuery.message.photo) {
                await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            } else {
                await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            }
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                console.error('Error updating quantity message (qty_set):', e);
            }
        }
    } catch (error) {
        console.error('Error in qty_set buttons:', error);
        await ctx.answerCbQuery('❌ Terjadi kesalahan saat memilih jumlah.', { show_alert: true });
    }
});

// ==== CUSTOM JUMLAH: minta user mengetik angka. qty_custom:{productId}:{variantSlug}:{page} ====
bot.action(/^qty_custom:([^:]+):(.+):(\d+)$/, async (ctx) => {
    try {
        const [, productId, variantSlug, pageStr] = ctx.match;
        const page = parseInt(pageStr, 10);
        const userId = ctx.from.id.toString();

        const { variant } = await findProductAndVariant(productId, variantSlug);
        if (!variant) {
            return await ctx.answerCbQuery('❌ Varian produk tidak ditemukan.', { show_alert: true });
        }
        const maxStock = variant.stock.length;

        // Simpan konteks agar handler teks tahu ini input jumlah custom
        userStates[userId] = { state: 'awaiting_custom_qty', productId, variantSlug, page, maxStock };

        await ctx.answerCbQuery();
        await ctx.reply(`✍️ Ketik jumlah yang Anda inginkan (1 - ${maxStock}), lalu kirim.\n\nContoh: 15`);
    } catch (error) {
        console.error('Error in qty_custom button:', error);
        await ctx.answerCbQuery('❌ Terjadi kesalahan.', { show_alert: true });
    }
});

bot.action(/^proceed_payment:([^:]+):(.+):(\d+):(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const [, productId, variantSlug, quantityStr, pageStr] = ctx.match;
        const quantity = parseInt(quantityStr, 10);
        const page = parseInt(pageStr, 10);
        // ... (sisa isi fungsi ini sama persis seperti sebelumnya, tidak perlu diubah)
        const { message, keyboard } = await generatePaymentMessageAndKeyboard(productId, variantSlug, quantity, page);

        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        } else {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in proceed_payment:', error);
    }
});

bot.action(/^back_to_qty_([^_]+)_(.*?)_(\d+)_page_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const quantity = parseInt(ctx.match[3]);
        const page = parseInt(ctx.match[4]);
        const { message, keyboard } = await generateQuantityMessageAndKeyboard(productId, variantSlug, quantity, page);
        
        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        } else {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in back_to_qty:', error);
    }
});

bot.action(/^back_to_details_([^_]+)_page_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const page = parseInt(ctx.match[2]);
        const { message, keyboard } = await generateProductDetailsMessageAndKeyboard(productId, page);
        
        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        } else {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in back_to_details:', error);
    }
});

// FINAL -NOTIF/all.js

bot.action(/^dana_([^_]+)_(.*?)_(\d+)$/, async (ctx) => {
    let workingMsg, qrPhotoMsg;
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const quantity = parseInt(ctx.match[3]);
    const internalOrderId = `WXSID-${ctx.from.id}-${Date.now()}`;
    let reservedItems = [];
    let transactionCommitted = false; // <-- Penanda baru

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        await ctx.deleteMessage();
        workingMsg = await ctx.reply('⏳ *Membuat invoice unik Anda...*', { parse_mode: 'Markdown' });

        const product = await Product.findOne({ id: productId }).session(session);
        if (!product) throw new Error('Produk tidak ditemukan.');

        const variant = product.variants.find(v => v.slug === variantSlug);
        if (!variant || !variant.stock || variant.stock.length < quantity) {
            throw new Error('Maaf, stok tidak mencukupi.');
        }

        reservedItems = variant.stock.slice(0, quantity);
        variant.stock.splice(0, quantity);
        variant.reserved_stock.push(...reservedItems);
        await product.save({ session });

        const totalHarga = quantity * (variant.bulk_pricing && quantity >= variant.bulk_pricing.min_quantity ? variant.bulk_pricing.price_per_item : variant.price);
        const finalAmount = Math.round(totalHarga + (totalHarga * 0.002) + (Math.floor(Math.random() * 10) + 1));

        await new Order({
            orderId: internalOrderId,
            amount: finalAmount,
            status: "PENDING",
            expiresAt: junkOrderExpiry(),
            productId, variantSlug, quantity, reservedItems,
            productName: product.name,
            variantName: variant.name,
            customerInfo: { telegramUserId: ctx.from.id.toString(), first_name: ctx.from.first_name },
            paymentGateway: "dana",
        }).save({ session });

        await session.commitTransaction();
        transactionCommitted = true; // <-- Tandai transaksi DB berhasil

        await dana.createDanaPayment(internalOrderId, finalAmount);
        const qrImageBuffer = await dana.generateDanaQris(finalAmount);
        
        const caption = `📁 *Invoice DANA Berhasil Dibuat*\n\`\`\`\n${internalOrderId}\n\`\`\`\n────────────✧\n*HANYA SUPPORT PEMBAYARAN LEWAT DANA!*\n────────────✧\n*Info Item:*\n— Total Harga: Rp ${totalHarga.toLocaleString('id-ID')}\n— Jumlah: ${quantity}x\n\n*Info Pembayaran:*\n— ID Transaksi: \`${internalOrderId}\`\n— Total Dibayar: Rp ${finalAmount.toLocaleString('id-ID')}\n— Kedaluwarsa: 3 Menit`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Batalkan Pembelian', `cancel_payment_dana_${internalOrderId}`)]]);
        
        if (workingMsg) await ctx.deleteMessage().catch(() => {});
        qrPhotoMsg = await ctx.replyWithPhoto({ source: qrImageBuffer }, { caption, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

        // ... (Sisa kode polling tetap sama)
        const pollInterval = 3000;
        const pollDuration = 180000;
        let isHandled = false;

        const stopPolling = () => {
            const sessionData = paymentSessions.get(internalOrderId);
            if (sessionData) {
                clearInterval(sessionData.pollingId);
                clearTimeout(sessionData.timeoutId);
                paymentSessions.delete(internalOrderId);
            }
        };
        
        const handleExpiry = async () => {
            if (isHandled) return;
            isHandled = true;
            stopPolling();

            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug },
                {
                    $push: { "variants.$.stock": { $each: reservedItems } },
                    $pull: { "variants.$.reserved_stock": { $in: reservedItems } }
                }
            );
            await Order.updateOne({ orderId: internalOrderId, status: 'PENDING' }, { $set: { status: 'EXPIRED' } });
            
            await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            await bot.telegram.sendMessage(ctx.from.id, `📜 *Tagihan DANA Kadaluarsa* untuk ID \`${internalOrderId}\``, { parse_mode: 'Markdown' });
        };
        
        const timeoutId = setTimeout(handleExpiry, pollDuration);

        const pollingId = setInterval(async () => {
            if (isHandled) return;
            try {
                const statusResult = await dana.checkDanaPaymentStatus(internalOrderId);

                if (statusResult?.status?.toLowerCase() === "success") {
                    isHandled = true;
                    stopPolling();

                    const order = await Order.findOneAndUpdate(
                        { orderId: internalOrderId, status: 'PENDING' },
                        {
                            $set: { status: 'PAID', paidAt: new Date(), paymentDetails: slimPaymentDetails(statusResult) },
                            $unset: { expiresAt: '' }
                        },
                        { new: true }
                    );

                    if (order) {
                        await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } });
                        await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } });

                        // Kirim akun via helper tahan-banting (fallback + lapor owner bila gagal).
                        await deliverAccountsToCustomer(order, 'DANA');
                    }
                }
            } catch (pollError) {
                console.error('[DANA] poll error:', pollError.message);
            }
        }, pollInterval);

        paymentSessions.set(internalOrderId, { pollingId, timeoutId, qrPhotoMsgId: qrPhotoMsg.message_id });

    } catch (error) {
        console.error('Error in DANA action:', error);
        
        // Logika penanganan error yang baru
        if (!transactionCommitted) {
            // Jika error terjadi SEBELUM commit, batalkan transaksi DB
            await session.abortTransaction();
        } else {
            // Jika error terjadi SETELAH commit, jalankan recovery stok manual
            await handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId);
        }

        if (workingMsg) await ctx.deleteMessage(workingMsg.message_id).catch(() => {});
        await ctx.reply('❌ Maaf, terjadi kesalahan internal saat membuat invoice. Silakan coba lagi nanti.');

    } finally {
        session.endSession();
    }
});

bot.action(/^qris_([^_]+)_(.*?)_(\d+)$/, async (ctx) => {
    let workingMsg, qrPhotoMsg;
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const quantity = parseInt(ctx.match[3]);
    const internalOrderId = `WXSID-${ctx.from.id}-${Date.now()}`;
    let reservedItems = [];
    let transactionCommitted = false; // <-- Penanda baru

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        await ctx.deleteMessage();
        workingMsg = await ctx.reply('⏳ *Membuat QRIS, mohon tunggu...*', { parse_mode: 'Markdown' });

        const product = await Product.findOne({ id: productId }).session(session);
        if (!product) throw new Error('Produk tidak ditemukan.');

        const variant = product.variants.find(v => v.slug === variantSlug);
        if (!variant || !variant.stock || variant.stock.length < quantity) {
            throw new Error('Maaf, stok tidak mencukupi.');
        }

        reservedItems = variant.stock.slice(0, quantity);
        variant.stock.splice(0, quantity);
        variant.reserved_stock.push(...reservedItems);
        await product.save({ session });

        const totalHarga = quantity * (variant.bulk_pricing && quantity >= variant.bulk_pricing.min_quantity ? variant.bulk_pricing.price_per_item : variant.price);
        
        const orderDetails = { productId, variantSlug, productName: product.name, variantName: variant.name, quantity, reservedItems };
        const customerInfo = { telegramUserId: ctx.from.id.toString(), first_name: ctx.from.first_name };
        
        const payment = await linkqu.createOrder(internalOrderId, totalHarga, orderDetails, customerInfo);
        
        await new Order({
            orderId: payment.realOrderId,
            internalRefId: internalOrderId,
            amount: payment.amount,
            status: "PENDING",
            expiresAt: junkOrderExpiry(),
            ...orderDetails,
            customerInfo,
            paymentGateway: "linkqu",
        }).save({ session });
        
        await session.commitTransaction();
        transactionCommitted = true; // <-- Tandai transaksi DB berhasil

        const totalToPay = (payment.amount || totalHarga) + (payment.fee || 0);
        const caption = `📁 *Invoice Berhasil Dibuat*\n\`\`\`\n${payment.realOrderId}\n\`\`\`\n────────────✧\n*QRIS SEMUA PEMBAYARAN*\n────────────✧\n*Info Item:*\n— Total Harga: Rp ${totalHarga.toLocaleString('id-ID')}\n— Jumlah: ${quantity}x\n\n*Info Pembayaran:*\n— ID Transaksi: \`${payment.realOrderId}\`\n— Total Dibayar: Rp ${totalHarga.toLocaleString('id-ID')}\n— Kedaluwarsa: 3 Menit`;
        
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Batalkan Pembelian', `cancel_payment_${payment.realOrderId}`)]]);
        
        await ctx.deleteMessage().catch(()=>{});
        qrPhotoMsg = await ctx.replyWithPhoto(payment.qrImage, { caption, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

        const pollInterval = 10000;
        const pollDuration = 180000;
        let isHandled = false;

        const stopPolling = () => {
            const sessionData = paymentSessions.get(payment.realOrderId);
            if (sessionData) {
                clearInterval(sessionData.pollingId);
                clearTimeout(sessionData.timeoutId);
                paymentSessions.delete(payment.realOrderId);
            }
        };
        
        // REVISI: Fungsi handleExpiry sekarang menggunakan Mongoose
        const handleExpiry = async () => {
            if (isHandled) return;
            isHandled = true;
            stopPolling();

            // Kembalikan stok yang dicadangkan secara atomik
            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug },
                {
                    $push: { "variants.$.stock": { $each: reservedItems } },
                    $pull: { "variants.$.reserved_stock": { $in: reservedItems } }
                }
            );
            // Update status pesanan
            await Order.updateOne({ orderId: payment.realOrderId, status: 'PENDING' }, { $set: { status: 'EXPIRED' } });
            
            await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            const expiryMessage = `📜 *Tagihan Kadaluarsa*\n\nTagihan untuk ID \`${payment.realOrderId}\` telah kadaluarsa.`;
            await bot.telegram.sendMessage(ctx.from.id, expiryMessage, { parse_mode: 'Markdown' });
        };
        
        const timeoutId = setTimeout(handleExpiry, pollDuration);

        const pollingId = setInterval(async () => {
            if (isHandled) return;
            try {
                const statusResult = await linkqu.checkPaymentStatus(payment.realOrderId);

                if (statusResult.status === "PAID") {
                    isHandled = true;
                    stopPolling();
                    const order = statusResult.order;
                    
                    await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } });
                    await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } });
                    
                    // Kirim akun via helper tahan-banting (fallback + lapor owner bila gagal).
                    await deliverAccountsToCustomer(order, 'QRIS');

                } else if (statusResult.status === "EXPIRED" || statusResult.status === "FAILED") {
                    await handleExpiry();
                }
            } catch (pollError) {
                console.error("Error saat polling Linkqu:", pollError);
                isHandled = true;
                stopPolling();
            }
        }, pollInterval);

        paymentSessions.set(payment.realOrderId, { pollingId, timeoutId, qrPhotoMsgId: qrPhotoMsg.message_id });

    } catch (error) {
        console.error('Error in Linkqu action:', error);
        
        // Logika penanganan error yang baru
        if (!transactionCommitted) {
            // Jika error terjadi SEBELUM commit, batalkan transaksi DB
            await session.abortTransaction();
        } else {
            // Jika error terjadi SETELAH commit, jalankan recovery stok manual
            await handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId);
        }

        if (workingMsg) await ctx.deleteMessage(workingMsg.message_id).catch(() => {});
        await ctx.reply('❌ Maaf, terjadi kesalahan internal saat membuat invoice. Silakan coba lagi nanti.');

    } finally {
        session.endSession();
    }
});


bot.action(/^tokopay_([^_]+)_(.*?)_(\d+)$/, async (ctx) => {
    let workingMsg, qrPhotoMsg;
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const quantity = parseInt(ctx.match[3]);
    // Prefix ALIM- = PENANDA order milik tokotelealim. Bila memakai akun Pakasir
    // yang sama dengan tokoteledompet, bot tokoteledompet mengenali prefix ini dan
    // MENGABAIKAN callback-nya (tidak diproses sebagai order sendiri).
    const internalOrderId = `ALIM-${ctx.from.id}-${Date.now()}`;
    let reservedItems = [];
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
        await ctx.deleteMessage().catch(() => {});
        workingMsg = await ctx.reply('⏳ *Menyiapkan QRIS, mohon tunggu...*', { parse_mode: 'Markdown' });

        const product = await Product.findOne({ id: productId }).session(session);
        if (!product) throw new Error('Produk tidak ditemukan.');
        const variant = product.variants.find(v => v.slug === variantSlug);
        if (!variant || !variant.stock || variant.stock.length < quantity) {
            throw new Error('Maaf, stok tidak mencukupi.');
        }

        reservedItems = variant.stock.slice(0, quantity);
        variant.stock.splice(0, quantity);
        variant.reserved_stock.push(...reservedItems);
        await product.save({ session });

        let hargaPerPcs = variant.price;
        if (variant.bulk_pricing && quantity >= variant.bulk_pricing.min_quantity) {
            hargaPerPcs = variant.bulk_pricing.price_per_item;
        }
        const totalHarga = quantity * hargaPerPcs;

        // Simpan reservasi stok + order DULU (transaksi DB singkat), baru panggil Pakasir
        // di LUAR transaksi. Dengan begitu pembeli lain tidak kena "write conflict" saat
        // server Pakasir lambat. Kalau Pakasir gagal, stok dikembalikan oleh
        // handlePaymentCreationError (order ditandai FAILED).
        await new Order({
            orderId: internalOrderId,
            internalRefId: internalOrderId,
            amount: totalHarga,           // nominal dasar (diterima merchant) -> statistik
            status: "PENDING",
            expiresAt: pakasirOrderExpiry(),
            productId, variantSlug, productName: product.name, variantName: variant.name, quantity, reservedItems,
            customerInfo: { telegramUserId: ctx.from.id.toString(), first_name: ctx.from.first_name },
            paymentGateway: "pakasir",
        }).save({ session });
        await session.commitTransaction();
        transactionCommitted = true;

        const rawPayment = await pakasir.createTransaction(internalOrderId, totalHarga);
        console.log('[PAKASIR] Invoice dibuat:', JSON.stringify({ order: internalOrderId, txn: rawPayment.txnId, amount: rawPayment.amount, fee: rawPayment.fee, total: rawPayment.totalBayar }));

        const payment = {
            displayOrderId: internalOrderId,
            realOrderId: rawPayment.realOrderId,
            txnId: rawPayment.txnId,                     // v2: WAJIB utk cek status
            qrString: rawPayment.qrString,
            amount: rawPayment.amount,                   // nominal dasar (diterima merchant)
            totalBayar: rawPayment.totalBayar,           // yang dibayar customer (sudah + fee)
            fee: rawPayment.fee,
        };
        if (!payment.qrString) throw new Error("QR String tidak ditemukan dari response Pakasir");

        await Order.updateOne(
            { orderId: internalOrderId },
            { $set: { pakasirTxnId: payment.txnId, fee: payment.fee, totalPaid: payment.totalBayar, depositId: payment.realOrderId } }
        );

        const qrDataURL = await QRCode.toDataURL(payment.qrString, {
            type: 'image/png', width: 512, margin: 2, errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        const qrBuffer = Buffer.from(qrDataURL.split(",")[1], "base64");

        // Nama produk/varian di-escape supaya karakter _ * ` [ tidak merusak format (invoice gagal tampil).
        const caption = `📁 *Invoice Berhasil Dibuat*\n\`\`\`\n${payment.displayOrderId}\n\`\`\`\n────────────✧\n*QRIS SEMUA PEMBAYARAN*\n────────────✧\n*Informasi Item:*\n— Nama: ${escapeMd(String(product.name).toUpperCase())} - ${escapeMd(variant.name)}\n— Jumlah: ${quantity}x\n\n*Informasi Pembayaran:*\n— ID Transaksi: \`${payment.displayOrderId}\`\n— Harga: Rp ${Number(payment.amount).toLocaleString('id-ID')}\n— Biaya QRIS: Rp ${Number(payment.fee).toLocaleString('id-ID')}\n— Total Dibayar: Rp ${Number(payment.totalBayar).toLocaleString('id-ID')}\n— Kedaluwarsa dalam: 5 Menit`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Batalkan Pembelian', `cancel_payment_pakasir_${payment.displayOrderId}`)]]);

        await ctx.deleteMessage().catch(() => {});
        // hapus "⏳ Menyiapkan QRIS..." supaya tidak tertinggal di chat
        if (workingMsg) { await ctx.deleteMessage(workingMsg.message_id).catch(() => {}); workingMsg = null; }
        qrPhotoMsg = await ctx.replyWithPhoto({ source: qrBuffer }, { caption, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        await Order.updateOne({ orderId: internalOrderId }, { $set: { qrMsgId: qrPhotoMsg.message_id } }).catch(() => {});

        // ===== KONFIRMASI VIA POLLING (tiap 5 detik, maks 5 menit) =====
        // Cadangan: sweepPakasirOrders() mengecek ulang tiap 2 menit (restart / bayar telat).
        const pollInterval = 5000;
        const pollDuration = 300000; // 5 menit
        let isHandled = false;       // timer sudah dihentikan (lunas / kedaluwarsa)
        let polling = false;         // cegah request cek status menumpuk
        const startedAt = Date.now();

        const finish = () => {
            const s = paymentSessions.get(payment.displayOrderId);
            if (s) {
                clearInterval(s.pollingId);
                clearTimeout(s.timeoutId);
                paymentSessions.delete(payment.displayOrderId);
            }
        };

        // Pembayaran terdeteksi -> kirim akun (fungsi ini juga menghapus QR).
        // Kalau order keburu ditandai kedaluwarsa (bayar di detik terakhir),
        // diproses sebagai pembayaran telat.
        const onPaid = async () => {
            try {
                const r = await fulfillPakasirPaidOrder(payment.displayOrderId);
                if (!r.ok && r.reason === 'not_pending') await fulfillLatePakasirOrder(payment.displayOrderId);
            } finally {
                // Walau terjadi error DB, timer dihentikan & sesi dilepas -> sweeper 2 menitan
                // yang akan mencoba lagi (order tidak "nyangkut" dipantau polling mati).
                finish();
                await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            }
        };

        const handleExpiry = async () => {
            if (isHandled) return;
            isHandled = true;
            finish();
            // Cek terakhir ke Pakasir: jangan batalkan order yang ternyata sudah dibayar.
            if (await pakasirStatusOf(payment.txnId) === 'completed') { await onPaid(); return; }
            const expired = await expirePakasirOrder(payment.displayOrderId);
            if (!expired) return; // sudah dibayar / diproses
            await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            await bot.telegram.sendMessage(ctx.from.id, `📜 *Tagihan Kadaluarsa*\n\nTagihan untuk ID \`${payment.displayOrderId}\` telah kadaluarsa.\nJika Anda terlanjur membayar, tenang — akun tetap dikirim otomatis begitu pembayaran terdeteksi.`, { parse_mode: 'Markdown' }).catch(() => {});
        };

        const pollOnce = async () => {
            if (isHandled || polling) return;
            if (Date.now() - startedAt > pollDuration) { await handleExpiry(); return; }
            polling = true;
            try {
                if (await pakasirStatusOf(payment.txnId) === 'completed') {
                    // Tetap diproses walau timer kedaluwarsa jalan bersamaan: fungsi pemenuhan
                    // bersifat atomik, jadi akun tidak mungkin terkirim dua kali.
                    isHandled = true;
                    await onPaid();
                }
            } catch (e) {
                console.error('[PAKASIR] poll error:', e.message);
            } finally {
                polling = false;
            }
        };

        const pollingId = setInterval(pollOnce, pollInterval);
        const timeoutId = setTimeout(handleExpiry, pollDuration);
        paymentSessions.set(payment.displayOrderId, {
            pollingId, timeoutId,
            qrPhotoMsgId: qrPhotoMsg.message_id,
            chatId: ctx.chat.id,
            userId: ctx.from.id,
        });

    } catch (error) {
        console.error('[PAKASIR] Error in action:', error);
        if (!transactionCommitted) {
            await session.abortTransaction().catch(() => {});
        } else {
            await handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId);
        }
        const stokHabis = !!(error && error.message === 'Maaf, stok tidak mencukupi.');
        if (workingMsg) await ctx.deleteMessage(workingMsg.message_id).catch(() => {});
        await ctx.reply(stokHabis
            ? '❌ Maaf, stok tidak mencukupi (baru saja habis dibeli). Silakan kurangi jumlah atau coba lagi nanti.'
            : '❌ Maaf, terjadi kesalahan internal saat membuat invoice. Silakan coba lagi nanti.').catch(() => {});
        if (!stokHabis) {
            const detail = (error && error.message) ? error.message : String(error);
            for (const ownerId of ownerIdList()) {
                await bot.telegram.sendMessage(ownerId, `⚠️ [DEBUG PAKASIR] Gagal membuat invoice:\n${detail}`).catch(() => {});
            }
        }
    } finally {
        session.endSession();
    }
});

// ===== Pemenuhan order Pakasir yang sudah dibayar (dipanggil polling / reconcile) =====
async function fulfillPakasirPaidOrder(orderId) {
    // Idempoten: hanya proses order yang MASIH PENDING (aman thd polling + webhook + sweeper).
    const order = await Order.findOneAndUpdate(
        { orderId: orderId, status: 'PENDING' },
        { $set: { status: 'PAID', paidAt: new Date() }, $unset: { expiresAt: "" } },
        { new: true }
    );
    if (!order) {
        const existing = await Order.findOne({ orderId: orderId }).lean();
        if (existing && existing.status === 'PAID') return { ok: false, reason: 'already_paid' };
        return { ok: false, reason: 'not_pending' };
    }

    const sess = paymentSessions.get(orderId);
    if (sess) {
        clearInterval(sess.pollingId);
        clearTimeout(sess.timeoutId);
        paymentSessions.delete(orderId);
        if (sess.chatId && sess.qrPhotoMsgId) {
            await bot.telegram.deleteMessage(sess.chatId, sess.qrPhotoMsgId).catch(() => {});
        }
    } else if (order.qrMsgId && order.customerInfo && order.customerInfo.telegramUserId) {
        // sesi polling sudah tidak ada (mis. dibayar saat bot restart) -> hapus QR lewat id tersimpan
        await bot.telegram.deleteMessage(order.customerInfo.telegramUserId, order.qrMsgId).catch(() => {});
    }

    await Product.updateOne(
        { id: order.productId, "variants.slug": order.variantSlug },
        { $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }
    );
    await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } });

    // Kirim akun via helper tahan-banting (fallback teks biasa + lapor owner bila gagal).
    await deliverAccountsToCustomer(order, 'QRIS');
    return { ok: true };
}

// =================================================================
// PEMBAYARAN TELAT / RESTART (Pakasir)
// QRIS Pakasir v2 tetap bisa dibayar sampai ±24 jam walau invoice di bot sudah
// "kedaluwarsa" 5 menit / dibatalkan pembeli. Supaya uang pembeli tidak hilang:
//   * sebelum order dibatalkan/kedaluwarsa, status dicek dulu ke Pakasir;
//   * sweepPakasirOrders() tiap 2 menit mengecek ulang order Pakasir 24 jam
//     terakhir (PENDING/EXPIRED/CANCELLED/FAILED) — juga menutup celah restart;
//   * order yang ternyata dibayar telat -> akun dikirim OTOMATIS
//     (akun lama bila masih ada di stok, kalau tidak ambil akun baru);
//     kalau stok habis -> owner & pembeli diberi tahu (kirim manual).
// =================================================================
async function pakasirStatusOf(txnId) {
    if (!txnId) return null;
    try {
        const res = await pakasir.checkPaymentStatus(txnId);
        const s = String((res && res.status) || '').toLowerCase();
        return s || null; // null = gagal cek (jaringan / rate limit)
    } catch (e) {
        return null;
    }
}

// PENDING -> EXPIRED secara atomik, BARU stok dikembalikan (tidak mungkin dobel).
async function expirePakasirOrder(orderId) {
    const order = await Order.findOneAndUpdate(
        { orderId, status: 'PENDING' },
        { $set: { status: 'EXPIRED' } },
        { new: true }
    );
    if (!order) return false;
    if (order.qrMsgId && order.customerInfo && order.customerInfo.telegramUserId) {
        await bot.telegram.deleteMessage(order.customerInfo.telegramUserId, order.qrMsgId).catch(() => {});
    }
    if (order.reservedItems && order.reservedItems.length > 0) {
        await Product.updateOne(
            { id: order.productId, 'variants.slug': order.variantSlug },
            {
                $push: { 'variants.$.stock': { $each: order.reservedItems } },
                $pull: { 'variants.$.reserved_stock': { $in: order.reservedItems } }
            }
        ).catch((e) => console.error(`[PAKASIR] gagal kembalikan stok ${orderId}:`, e.message));
    }
    return true;
}

// Ambil `qty` akun baru dari depan stok (transaksi) untuk pembayaran telat.
async function takeFreshItems(productId, variantSlug, qty) {
    const session = await mongoose.startSession();
    let picked = null;
    try {
        await session.withTransaction(async () => {
            picked = null;
            const product = await Product.findOne({ id: productId }).session(session);
            const variant = product && product.variants.find((v) => v.slug === variantSlug);
            if (!variant || !Array.isArray(variant.stock) || variant.stock.length < qty) return;
            picked = variant.stock.slice(0, qty);
            variant.stock.splice(0, qty);
            await product.save({ session });
        });
        return picked;
    } catch (e) {
        console.error('[PAKASIR] takeFreshItems error:', e.message);
        return null;
    } finally {
        session.endSession();
    }
}

async function fulfillLatePakasirOrder(orderId) {
    // Klaim atomik: hanya satu proses (polling/webhook/sweeper) yang menangani.
    // reservedItems langsung dikosongkan saat klaim: akun lama mungkin sudah terjual ke orang
    // lain, jadi /resend tidak boleh mengirimnya. Akun yang benar diisi lagi di bawah.
    const order = await Order.findOneAndUpdate(
        { orderId, paymentGateway: 'pakasir', status: { $in: ['EXPIRED', 'CANCELLED', 'FAILED'] } },
        { $set: { status: 'PAID', paidAt: new Date(), latePaid: true, reservedItems: [] }, $unset: { expiresAt: '' } },
        { new: false } // dokumen SEBELUM diubah -> masih berisi daftar akun lama
    );
    if (!order) return { ok: false, reason: 'not_late' };
    order.status = 'PAID';
    order.latePaid = true;

    const oldItems = Array.isArray(order.reservedItems) ? order.reservedItems.slice() : [];
    const qty = order.quantity || oldItems.length || 1;
    const buyer = order.customerInfo && order.customerInfo.telegramUserId;
    let items = null;
    // 1) Akun yang dulu direservasi masih ada di stok? -> ambil kembali persis akun itu.
    if (oldItems.length > 0) {
        const r = await Product.updateOne(
            { id: order.productId, variants: { $elemMatch: { slug: order.variantSlug, stock: { $all: oldItems } } } },
            { $pull: { 'variants.$.stock': { $in: oldItems } } }
        ).catch(() => null);
        if (r && r.modifiedCount === 1) items = oldItems;
    }
    // 2) Kalau sudah terjual ke orang lain -> ambil akun baru dari stok.
    if (!items) items = await takeFreshItems(order.productId, order.variantSlug, qty);

    const label = `${order.productName || '-'}${order.variantName ? ' - ' + order.variantName : ''}`;
    if (!items) {
        // Stok habis: order tetap LUNAS tapi belum terkirim -> muncul di /belumkirim
        // (setelah dikirim manual, tandai dengan /tandaikirim <ID order>).
        for (const id of ownerIdList()) {
            await bot.telegram.sendMessage(id,
                `💰⚠️ PEMBAYARAN TELAT DITERIMA — STOK HABIS\n\nOrder: ${orderId}\nUser: ${buyer || '-'}\nProduk: ${label} x${qty}\n` +
                `Dibayar: Rp ${Number(order.totalPaid || order.amount || 0).toLocaleString('id-ID')}\n\n` +
                'Pembeli membayar setelah invoice kedaluwarsa/dibatalkan, tetapi stok sudah habis. Kirim akun manual atau refund, lalu /tandaikirim ' + orderId
            ).catch(() => {});
        }
        if (buyer) {
            await bot.telegram.sendMessage(buyer,
                `✅ Pembayaran Anda untuk order ${orderId} sudah kami terima.\n\n` +
                'Stok untuk pesanan ini sedang kosong, admin akan segera mengirim akun Anda secara manual atau menghubungi Anda. Mohon ditunggu 🙏'
            ).catch(() => {});
        }
        return { ok: false, reason: 'no_stock' };
    }

    await Order.updateOne({ _id: order._id }, { $set: { reservedItems: items } });
    order.reservedItems = items;
    await User.updateOne({ id: buyer }, { $inc: { totalSpent: order.amount } }).catch(() => {});
    for (const id of ownerIdList()) {
        await bot.telegram.sendMessage(id,
            `💰 Pembayaran TELAT diterima untuk order ${orderId} (${label} x${qty}). Akun dikirim otomatis ke pembeli.`
        ).catch(() => {});
    }
    await deliverAccountsToCustomer(order, 'QRIS');
    return { ok: true };
}

// Cek ulang berkala order Pakasir 24 jam terakhir.
// Umur < 1 jam dicek tiap ±2 menit, sisanya tiap ±15 menit (hemat request).
let pakasirSweeping = false;
async function sweepPakasirOrders() {
    if (pakasirSweeping) return;
    pakasirSweeping = true;
    try {
        const now = Date.now();
        const candidates = await Order.find({
            paymentGateway: 'pakasir',
            pakasirTxnId: { $exists: true, $ne: null },
            status: { $in: ['PENDING', 'EXPIRED', 'CANCELLED', 'FAILED'] },
            pakasirFinal: { $ne: true },
            createdAt: { $gte: new Date(now - 25 * 60 * 60 * 1000) },
        }).sort({ pakasirCheckedAt: 1 }).limit(80).lean();

        let checks = 0;
        for (const o of candidates) {
            if (paymentSessions.has(o.orderId)) continue; // masih dipantau polling aktif
            const age = now - new Date(o.createdAt).getTime();
            const every = age < 60 * 60 * 1000 ? 2 * 60 * 1000 : 15 * 60 * 1000;
            if (o.pakasirCheckedAt && now - new Date(o.pakasirCheckedAt).getTime() < every - 5000) continue;
            if (checks >= 25) break;
            checks += 1;

            const st = await pakasirStatusOf(o.pakasirTxnId);
            if (st) await Order.updateOne({ _id: o._id }, { $set: { pakasirCheckedAt: new Date() } }).catch(() => {});
            try {
                if (st === 'completed') {
                    if (o.status === 'PENDING') {
                        const r = await fulfillPakasirPaidOrder(o.orderId);
                        if (!r.ok && r.reason === 'not_pending') await fulfillLatePakasirOrder(o.orderId);
                    } else {
                        await fulfillLatePakasirOrder(o.orderId);
                    }
                    console.log(`[PAKASIR SWEEP] ${o.orderId} ternyata sudah dibayar -> diproses.`);
                } else if (st === 'canceled' || st === 'cancelled' || st === 'expired' || st === 'failed') {
                    await Order.updateOne({ _id: o._id }, { $set: { pakasirFinal: true } }).catch(() => {});
                    if (o.status === 'PENDING') await expirePakasirOrder(o.orderId);
                } else if (st === 'pending' && o.status === 'PENDING' && age > 15 * 60 * 1000) {
                    // Tidak ada polling aktif (mis. bot restart) & belum dibayar -> kembalikan stok.
                    // Order tetap dipantau: kalau dibayar telat, akun tetap dikirim.
                    await expirePakasirOrder(o.orderId);
                }
            } catch (e) {
                console.error(`[PAKASIR SWEEP] ${o.orderId} error:`, e.message);
            }
            await new Promise((r) => setTimeout(r, 400));
        }
    } catch (e) {
        console.error('[PAKASIR SWEEP] Error:', e.message);
    } finally {
        pakasirSweeping = false;
    }
}

// Rekonsiliasi saat startup: kalau bot mati SETELAH customer bayar tapi SEBELUM
// polling melihat "completed", cek ulang order Pakasir PENDING langsung ke Pakasir.
async function reconcilePakasirPendingOrders() {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const pendings = await Order.find({
            status: 'PENDING',
            paymentGateway: 'pakasir',
            createdAt: { $gte: since },
        }).lean();
        if (pendings.length === 0) return;
        console.log(`[RECONCILE] Cek ulang ${pendings.length} order Pakasir PENDING...`);
        let fulfilled = 0;
        for (const o of pendings) {
            try {
                const res = await pakasir.checkPaymentStatus(o.pakasirTxnId);
                const status = String(res?.status || '').toLowerCase();
                if (status === 'completed') {
                    const r = await fulfillPakasirPaidOrder(o.orderId);
                    if (r && r.ok) { fulfilled += 1; console.log(`[RECONCILE] Order ${o.orderId} dipenuhi.`); }
                }
            } catch (e) {
                console.error(`[RECONCILE] gagal cek ${o.orderId}:`, e.message);
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        if (fulfilled > 0) console.log(`[RECONCILE] Selesai: ${fulfilled} order dipenuhi setelah restart.`);
    } catch (error) {
        console.error('[RECONCILE] Error:', error.message);
    }
}

// Handler pembatalan pembayaran Pakasir (QRIS ALL). Didaftarkan sebelum handler generic.
bot.action(/^cancel_payment_pakasir_(.*)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery().catch(() => {});
        const orderId = ctx.match[1];
        // Cek dulu ke Pakasir: kalau ternyata SUDAH dibayar, pesanan tidak dibatalkan.
        const existing = await Order.findOne({ orderId }).lean();
        if (existing && existing.status === 'PENDING' && existing.pakasirTxnId
            && await pakasirStatusOf(existing.pakasirTxnId) === 'completed') {
            const r = await fulfillPakasirPaidOrder(orderId);
            if (r.ok || r.reason === 'already_paid') {
                await ctx.reply('✅ Pembayaran Anda sudah kami terima, jadi pesanan tidak dibatalkan. Akun dikirim di chat ini.').catch(() => {});
                return;
            }
        }
        const paymentSession = paymentSessions.get(orderId);
        if (paymentSession) {
            clearInterval(paymentSession.pollingId);
            clearTimeout(paymentSession.timeoutId);
            paymentSessions.delete(orderId);
            await ctx.deleteMessage(paymentSession.qrPhotoMsgId).catch(() => {});
        } else {
            await ctx.deleteMessage().catch(() => {});
        }
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const order = await Order.findOneAndUpdate({ orderId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: new Date() } }, { new: true, session: session });
            if (!order) {
                await ctx.reply('Pesanan tidak ditemukan atau sudah diproses.');
                await session.abortTransaction().catch(() => {});
                session.endSession();
                return;
            }
            if (order.reservedItems && order.reservedItems.length > 0) {
                await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $push: { "variants.$.stock": { $each: order.reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }).session(session);
            }
            await session.commitTransaction();
            await ctx.reply('❌ Pesanan QRIS Anda telah berhasil dibatalkan.\nMohon JANGAN membayar QRIS yang sudah dibatalkan.').catch(() => {});
        } catch (dbError) {
            await session.abortTransaction().catch(() => {});
            console.error('Database error during Pakasir cancellation:', dbError);
            await ctx.reply('❌ Terjadi kesalahan internal saat membatalkan pesanan.');
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error in cancel_payment_pakasir:', error);
        await ctx.reply('❌ Terjadi kesalahan saat memproses pembatalan.');
    }
});

// ===== Pemenuhan order yang sudah dibayar (dipanggil oleh webhook QRIN — legacy) =====
async function fulfillQrinPaidOrder(orderId) {
    const order = await Order.findOneAndUpdate(
        { orderId: orderId, status: 'PENDING', paymentGateway: 'qrin' }, // hanya order QRIN
        { $set: { status: 'PAID', paidAt: new Date() }, $unset: { expiresAt: "" } },
        { new: true }
    );
    if (!order) {
        const existing = await Order.findOne({ orderId: orderId }).lean();
        if (existing && existing.status === 'PAID') return { ok: false, reason: 'already_paid' };
        return { ok: false, reason: 'not_pending' };
    }

    const sess = paymentSessions.get(orderId);
    if (sess) {
        clearTimeout(sess.timeoutId);
        paymentSessions.delete(orderId);
        if (sess.chatId && sess.qrPhotoMsgId) {
            await bot.telegram.deleteMessage(sess.chatId, sess.qrPhotoMsgId).catch(() => {});
        }
    }

    await Product.updateOne(
        { id: order.productId, "variants.slug": order.variantSlug },
        { $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }
    );
    await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } });

    // Kirim akun via helper tahan-banting (fallback teks biasa + lapor owner bila gagal).
    await deliverAccountsToCustomer(order, 'QRIS');
    return { ok: true };
}

// ===== Webhook / Callback QRIN =====
// Daftarkan URL callback di QRIN ke: https://alimcloud.id/callback
// Tanda tangan: header X-Callback-Signature = HMAC-SHA256(raw body, QRIN_TOKEN).
app.get(['/health', '/ping'], (req, res) => res.status(200).json({ status: 'ok', paymentGateway: 'qrin', qrinConfigured: Boolean(process.env.QRIN_TOKEN) }));

app.post(['/callback', '/qrin/callback'], async (req, res) => {
    try {
        const signature = req.headers['x-callback-signature'];
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
        if (!qrin.verifyCallbackSignature(rawBody, signature)) {
            console.warn('[QRIN CALLBACK] Signature tidak valid');
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }
        const data = req.body || {};
        const orderId = data.no_ref_merchant;
        const status = String(data.status || '').toLowerCase();
        console.log(`[QRIN CALLBACK] order=${orderId} status=${status}`);
        if (!orderId) return res.status(400).json({ success: false, message: 'no_ref_merchant missing' });

        if (status === 'success') {
            const result = await fulfillQrinPaidOrder(orderId);
            if (!result.ok && result.reason === 'not_pending') {
                for (const ownerId of ownerIdList()) {
                    await bot.telegram.sendMessage(ownerId, `⚠️ [QRIN] Pembayaran diterima untuk order ${orderId} tetapi status order bukan PENDING. Perlu cek manual.`).catch(() => {});
                }
            }
        }
        return res.json({ success: true });
    } catch (e) {
        console.error('[QRIN CALLBACK] Error:', e.message);
        return res.status(500).json({ success: false });
    }
});

// Handler pembatalan pembayaran QRIN (QRIS ALL). Didaftarkan sebelum handler generic.
bot.action(/^cancel_payment_qrin_(.*)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const paymentSession = paymentSessions.get(orderId);
        if (paymentSession) {
            clearTimeout(paymentSession.timeoutId);
            paymentSessions.delete(orderId);
            await ctx.deleteMessage(paymentSession.qrPhotoMsgId).catch(() => {});
        } else {
            await ctx.deleteMessage().catch(() => {});
        }
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const order = await Order.findOneAndUpdate({ orderId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: new Date() } }, { new: true, session: session });
            if (!order) {
                await ctx.reply('Pesanan tidak ditemukan atau sudah diproses.');
                await session.abortTransaction();
                session.endSession();
                return;
            }
            if (order.reservedItems && order.reservedItems.length > 0) {
                await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $push: { "variants.$.stock": { $each: order.reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }).session(session);
            }
            await session.commitTransaction();
            await ctx.reply('❌ Pesanan QRIS Anda telah berhasil dibatalkan.');
        } catch (dbError) {
            await session.abortTransaction();
            console.error('Database error during QRIN cancellation:', dbError);
            await ctx.reply('❌ Terjadi kesalahan internal saat membatalkan pesanan.');
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error in cancel_payment_qrin:', error);
        await ctx.reply('❌ Terjadi kesalahan saat memproses pembatalan.');
    }
});


// [KODE ASLI DIKEMBALIKAN] Handler terpisah untuk membatalkan pembayaran Tokopay
bot.action(/^cancel_payment_tokopay_(.*)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const paymentSession = paymentSessions.get(orderId);
        if (paymentSession) {
            clearInterval(paymentSession.pollingId);
            clearTimeout(paymentSession.timeoutId);
            paymentSessions.delete(orderId);
            await ctx.deleteMessage(paymentSession.qrPhotoMsgId).catch(() => {});
        } else {
            await ctx.deleteMessage().catch(() => {});
        }
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const order = await Order.findOneAndUpdate({ orderId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: new Date() } }, { new: true, session: session });
            if (!order) {
                await ctx.reply('Pesanan tidak ditemukan atau sudah diproses.');
                await session.abortTransaction();
                session.endSession();
                return;
            }
            if (order.reservedItems && order.reservedItems.length > 0) {
                await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $push: { "variants.$.stock": { $each: order.reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }).session(session);
            }
            await session.commitTransaction();
            await ctx.reply('❌ Pesanan Anda telah berhasil dibatalkan.');
        } catch (dbError) {
            await session.abortTransaction();
            console.error('Database error during Tokopay cancellation:', dbError);
            await ctx.reply('❌ Terjadi kesalahan internal saat membatalkan pesanan.');
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error in cancel_payment_tokopay:', error);
        await ctx.reply('❌ Terjadi kesalahan saat memproses pembatalan.');
    }
});

// [KODE ASLI DIKEMBALIKAN] Handler terpisah untuk membatalkan pembayaran DANA
bot.action(/^cancel_payment_dana_(.*)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        await dana.cancelDanaPayment(orderId); // Panggilan spesifik untuk DANA
        const paymentSession = paymentSessions.get(orderId);
        if (paymentSession) {
            clearInterval(paymentSession.pollingId);
            clearTimeout(paymentSession.timeoutId);
            paymentSessions.delete(orderId);
            await ctx.deleteMessage(paymentSession.qrPhotoMsgId).catch(() => {});
        } else {
            await ctx.deleteMessage().catch(() => {});
        }
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const order = await Order.findOneAndUpdate({ orderId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: new Date() } }, { new: true, session: session });
            if (!order) {
                await ctx.reply('Pesanan tidak ditemukan atau sudah diproses.');
                await session.abortTransaction();
                session.endSession();
                return;
            }
            if (order.reservedItems && order.reservedItems.length > 0) {
                await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $push: { "variants.$.stock": { $each: order.reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }).session(session);
            }
            await session.commitTransaction();
            await ctx.reply('❌ Pesanan DANA Anda telah berhasil dibatalkan.');
        } catch (dbError) {
            await session.abortTransaction();
            console.error('Database error during DANA cancellation:', dbError);
            await ctx.reply('❌ Terjadi kesalahan internal saat membatalkan pesanan.');
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error in cancel_payment_dana:', error);
        await ctx.reply('❌ Terjadi kesalahan saat memproses pembatalan.');
    }
});

// [KODE ASLI DIKEMBALIKAN] Handler terpisah untuk membatalkan pembayaran Linkqu (QRIS umum)
bot.action(/^cancel_payment_(.*)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const paymentSession = paymentSessions.get(orderId);
        if (paymentSession) {
            clearInterval(paymentSession.pollingId);
            clearTimeout(paymentSession.timeoutId);
            paymentSessions.delete(orderId);
            await ctx.deleteMessage(paymentSession.qrPhotoMsgId).catch(() => {});
        } else {
            await ctx.deleteMessage().catch(() => {});
        }
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const order = await Order.findOneAndUpdate({ orderId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: new Date() } }, { new: true, session: session });
            if (!order) {
                await ctx.reply('Pesanan tidak ditemukan atau sudah diproses.');
                await session.abortTransaction();
                session.endSession();
                return;
            }
            if (order.reservedItems && order.reservedItems.length > 0) {
                await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $push: { "variants.$.stock": { $each: order.reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } }).session(session);
            }
            await session.commitTransaction();
            await ctx.reply('❌ Pesanan QRIS Anda telah berhasil dibatalkan.');
        } catch (dbError) {
            await session.abortTransaction();
            console.error('Database error during Linkqu cancellation:', dbError);
            await ctx.reply('❌ Terjadi kesalahan internal saat membatalkan pesanan.');
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error in cancel_payment:', error);
        await ctx.reply('❌ Terjadi kesalahan saat memproses pembatalan.');
    }
});

bot.command('stock', async (ctx) => {
    try {
        const { message, keyboard } = await generateStockMessageAndKeyboard();
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (error) {
        console.error("Error in /stock command:", error);
        await ctx.reply("❌ Gagal memuat informasi stok.");
    }
});

// Tombol refresh pada pesan /stock
bot.action('refresh_stock', async (ctx) => {
    try {
        const { message, keyboard } = await generateStockMessageAndKeyboard();
        try {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            await ctx.answerCbQuery('✅ Stok diperbarui.');
        } catch (editError) {
            // Telegram menolak edit bila isi pesan sama persis.
            if (String(editError.description || editError.message || '').includes('message is not modified')) {
                await ctx.answerCbQuery('Stok masih sama.');
            } else {
                throw editError;
            }
        }
    } catch (error) {
        console.error('Error in refresh_stock:', error);
        try { await ctx.answerCbQuery('❌ Gagal memuat stok.', { show_alert: true }); } catch (e) {}
    }
});

bot.command('leaderboard', async (ctx) => {
    try {
        const topUsers = await User.find({}).sort({ totalSpent: -1 }).limit(5).lean();
        let message = '🏆 *Leaderboard Pengguna Teratas:*\n\n';
        if (topUsers.length === 0) {
            message += 'Belum ada pengguna yang melakukan transaksi.';
        } else {
            topUsers.forEach((user, index) => {
                const totalSpentRp = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(user.totalSpent);
                message += `${index + 1}. *${user.username || 'User'}:* ${totalSpentRp}\n`;
            });
        }
        ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /leaderboard:', error);
        ctx.reply('❌ Terjadi kesalahan saat memuat leaderboard.');
    }
});

bot.hears('🛒 List Produk', async (ctx) => {
    try {
        const { message, keyboard } = await generateProductListMessageAndKeyboard(1);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);
        if (fileExists) {
            await ctx.replyWithPhoto({ source: imagePath }, { caption: message, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in hears List Produk:', error);
        await ctx.reply('❌ Terjadi kesalahan saat menampilkan produk.');
    }
});

bot.hears('📦 Cek Stok', async (ctx) => {
    try {
        const { message, keyboard } = await generateStockMessageAndKeyboard();
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (error) {
        console.error("Error in hears Cek Stok:", error);
        await ctx.reply("❌ Gagal memuat informasi stok.");
    }
});

bot.hears('⚙️ Admin Panel', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(ctx.from.id.toString())) { return; }
    try {
        const { message, keyboard } = await adminModule.getAdminMenuMessageAndKeyboard();
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch(e) {
        console.error('Error in hears Admin Panel:', e);
        await ctx.reply('❌ Terjadi kesalahan saat membuka panel admin.');
    }
});

bot.hears('🧾 Riwayat Transaksi', async (ctx) => {
    try {
        const userId = ctx.from.id.toString();
        const userPaidOrders = await Order.find({ "customerInfo.telegramUserId": userId, status: 'PAID' }).lean();
        if (userPaidOrders.length === 0) {
            return ctx.reply('Anda belum memiliki riwayat transaksi yang berhasil.');
        }
        const purchaseSummary = {};
        userPaidOrders.forEach(order => {
            const key = `${order.productName} ${order.variantName}`;
            purchaseSummary[key] = (purchaseSummary[key] || 0) + order.quantity;
        });
        let message = `📋 *RIWAYAT PEMBELIAN ANDA*\nTotal Transaksi Berhasil: ${userPaidOrders.length}\n────────────✧\n`;
        Object.entries(purchaseSummary).forEach(([itemName, qty], index) => {
            message += `${index + 1}. ${itemName} x ${qty}\n`;
        });
        message += `────────────✧`;
        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error fetching transaction history:', error);
        await ctx.reply('❌ Gagal mengambil riwayat transaksi.');
    }
});

bot.hears(/^tambahproduk\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/, adminModule.adminMiddleware, async (ctx) => {
    try {
        const [, id, name, description] = ctx.match;
        const newId = id.trim();
        const existingProduct = await Product.findOne({ id: newId });
        if (existingProduct) {
            return ctx.reply('❌ Gagal. ID produk sudah ada, silakan gunakan ID lain.');
        }
        const newProduct = new Product({ id: newId, name: name.trim(), description: description.trim(), variants: [] });
        await newProduct.save();
        ctx.reply('✅ Produk baru berhasil ditambahkan!');
    } catch (error) {
        console.error('Error adding product:', error);
        if (error.code === 11000) {
            return ctx.reply('❌ Gagal. ID produk sudah ada, silakan gunakan ID lain.');
        }
        ctx.reply('❌ Gagal menambahkan produk. Pastikan format dan koneksi database benar.');
    }
});

bot.hears(/^editvarian\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)$/, adminModule.adminMiddleware, async (ctx) => {
    try {
        const [, productId, variantSlug, newName, newPrice] = ctx.match;
        const result = await Product.updateOne(
            { id: productId.trim(), "variants.slug": variantSlug.trim() },
            { $set: { "variants.$.name": newName.trim(), "variants.$.price": parseInt(newPrice) } }
        );
        if (result.matchedCount === 0) {
            return ctx.reply('❌ Gagal: Produk atau varian tidak ditemukan.');
        }
        if (result.modifiedCount === 0) {
            return ctx.reply('ℹ️ Tidak ada perubahan yang disimpan (data mungkin sudah sama).');
        }
        ctx.reply('✅ Varian berhasil diperbarui.');
    } catch (error) {
        console.error('Error editing variant:', error);
        ctx.reply('❌ Gagal mengedit varian. Pastikan format benar dan server database berjalan.');
    }
});

bot.hears(/^[^\/]/, async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = userStates[userId];
    if (!userState) return;
    
    try {
        if (userState.state === 'awaiting_custom_qty') {
            const { productId, variantSlug, page } = userState;
            let qty = parseInt(String(ctx.message.text).replace(/\D/g, ''), 10);

            // Ambil stok terkini (mungkin berubah sejak tombol ditekan)
            const { variant } = await findProductAndVariant(productId, variantSlug);
            const maxStock = variant ? variant.stock.length : 0;

            if (!variant || maxStock === 0) {
                delete userStates[userId];
                return ctx.reply('❌ Maaf, stok varian ini sudah habis. Silakan pilih produk lain.');
            }
            if (isNaN(qty) || qty < 1) {
                return ctx.reply(`❌ Jumlah tidak valid. Ketik angka antara 1 - ${maxStock}.`);
            }
            if (qty > maxStock) {
                return ctx.reply(`⚠️ Stok hanya tersisa ${maxStock}. Ketik angka antara 1 - ${maxStock}.`);
            }

            delete userStates[userId];
            const { message, keyboard } = await generateQuantityMessageAndKeyboard(productId, variantSlug, qty, page);
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

        } else if (userState.state === 'awaiting_stock') {
            const stockToAdd = ctx.message.text.split('\n').filter(line => line.trim() !== '');
            await adminModule.addStock(userState.productId, userState.variantSlug, stockToAdd, ctx);
            delete userStates[userId];

        } else if (userState.state === 'awaiting_take_stock_count') {
            const jumlah = parseInt(String(ctx.message.text).replace(/\D/g, ''), 10);
            await adminModule.takeStock(userState.productId, userState.variantSlug, jumlah, ctx);
            delete userStates[userId];

        } else if (userState.state === 'edit_product_name_desc') {
            const parts = ctx.message.text.split('|').map(p => p.trim());
            if (parts.length !== 2) {
                return ctx.reply('❌ Format tidak valid. Gunakan: `<Nama Baru> | <Deskripsi Baru>`');
            }
            await Product.updateOne(
                { id: userState.productId }, 
                { $set: { name: parts[0], description: parts[1] } }
            );
            delete userStates[userId];
            await ctx.reply(
                '✅ Nama dan deskripsi produk berhasil diperbarui!',
                Markup.inlineKeyboard([
                    Markup.button.callback('⬅️ Kembali', `admin_edit_product_${userState.productId}_page_${userState.page}`)
                ])
            );
            
        } else if (userState.state === 'add_new_variant') {
            const parts = ctx.message.text.split('|').map(p => p.trim());
            if (parts.length !== 3) {
                return ctx.reply('❌ Format tidak valid. Gunakan: `<Nama Varian> | <Harga> | <Slug Varian>`');
            }
            
            const price = parseInt(parts[1]);
            if (isNaN(price)) {
                return ctx.reply('❌ Format harga tidak valid. Harga harus berupa angka.');
            }
            
            const newVariantSlug = parts[2];
            const product = await Product.findOne({ id: userState.productId });
            
            if (product && product.variants.some(v => v.slug === newVariantSlug)) {
                return ctx.reply(
                    `❌ Gagal: Varian dengan slug \`${newVariantSlug}\` sudah ada untuk produk ini.`
                );
            }
            
            const newVariant = { 
                name: parts[0], 
                price, 
                slug: newVariantSlug, 
                stock: [], 
                snk: '-' 
            };
            
            await Product.updateOne(
                { id: userState.productId }, 
                { $push: { variants: newVariant } }
            );
            
            delete userStates[userId];
            await ctx.reply(
                '✅ Varian baru berhasil ditambahkan!',
                Markup.inlineKeyboard([
                    Markup.button.callback('⬅️ Kembali', `admin_edit_product_${userState.productId}_page_${userState.page}`)
                ])
            );
            
        } else if (userState.state === 'awaiting_broadcast_message') {
            const message = ctx.message.text;
            delete userStates[userId];

            const statusMessage = await ctx.reply('⏳ Menyiapkan broadcast...');

            // Helper edit status yang TIDAK PERNAH melempar error. Inilah bug
            // lamanya: edit status gagal (biasanya 429 setelah kirim massal),
            // errornya naik ke catch besar, dan admin melihat
            // "Terjadi kesalahan" padahal broadcast-nya sukses terkirim.
            const updateStatus = async (text) => {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, statusMessage.message_id, null, text,
                        { parse_mode: 'Markdown' }
                    );
                } catch (editError) {
                    const info = telegramErrorInfo(editError);
                    if (!info.description.includes('message is not modified')) {
                        console.error('Broadcast: gagal update status:', info.description);
                    }
                }
            };

            const result = await runBroadcast(ctx.telegram, {
                text: message,
                attachStock: true,
                onProgress: (done, running) => updateStatus(
                    `⏳ *Mengirim broadcast...*\n\n` +
                    `Terkirim: ${running.success} / ${running.total}`
                )
            });

            await updateStatus(formatBroadcastSummary(result));
            
        } else if (userState.state === 'awaiting_snk') {
            const newSnk = ctx.message.text;
            
            await Product.updateOne(
                { id: userState.productId, "variants.slug": userState.variantSlug }, 
                { $set: { "variants.$.snk": newSnk } }
            );
            
            await ctx.reply(
                '✅ SNK berhasil diperbarui!',
                Markup.inlineKeyboard([
                    Markup.button.callback('⬅️ Kembali Ke Menu', 'admin_menu')
                ])
            );
            
            delete userStates[userId];
            
        } else if (userState.state === 'awaiting_bulk_rule') {
            const text = ctx.message.text;
            const { productId, variantSlug } = userState;
            let updateOperation;
            
            if (text === '-') {
                updateOperation = { $unset: { "variants.$.bulk_pricing": "" } };
                await ctx.reply('✅ Aturan harga grosir berhasil dihapus.');
            } else {
                const parts = text.split('|').map(p => p.trim());
                
                if (parts.length !== 2 || isNaN(parseInt(parts[0])) || isNaN(parseInt(parts[1]))) {
                    return ctx.reply('❌ Format tidak valid. Gunakan: `jumlah_minimum|harga_per_pcs`');
                }
                
                const min_quantity = parseInt(parts[0]);
                const price_per_item = parseInt(parts[1]);
                
                if (min_quantity <= 1) {
                    return ctx.reply('❌ Jumlah minimum harus lebih dari 1.');
                }
                
                updateOperation = { 
                    $set: { 
                        "variants.$.bulk_pricing": { 
                            min_quantity, 
                            price_per_item 
                        } 
                    } 
                };
                
                await ctx.reply('✅ Aturan harga grosir berhasil disimpan!');
            }
            
            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug }, 
                updateOperation
            );
            
            delete userStates[userId];
            
        } else if (userState.state === 'awaiting_transfer_data') {
            const text = ctx.message.text.trim();
            
            // Step 1: Terima format data transfer
            if (userState.step === 'format') {
                // Parse data transfer dari format
                const parts = text.split('|').map(p => p.trim());
                
                // Validasi jumlah bagian
                if (parts.length < 4 || parts.length > 5) {
                    return ctx.reply(
                        '❌ Format salah! Gunakan: `kode_bank|nomor_rekening|nama_pemilik|nominal`\n' +
                        'Atau: `kode_bank|nomor_rekening|nama_pemilik|nominal|ref_id`\n\n' +
                        'Contoh: `bca|1234567890|John Doe|50000`',
                        { parse_mode: 'Markdown' }
                    );
                }

                // Ambil data (ref_id bisa ada atau tidak)
                let kodeBank, nomorAkun, namaPemilik, nominalStr, refId;
                
                if (parts.length === 5) {
                    [kodeBank, nomorAkun, namaPemilik, nominalStr, refId] = parts;
                } else {
                    [kodeBank, nomorAkun, namaPemilik, nominalStr] = parts;
                    refId = ''; // ref_id kosong, nanti dibuat otomatis
                }

                // Daftar bank utama yang umum digunakan (dari data API AtlanticH2H)
                const validBanks = [
                    // Bank Umum
                    'bca', 'bni', 'mandiri', 'bri', 'cimb', 'danamon', 'permata',
                    'panin', 'ocbc', 'maybank', 'btn', 'bukopin', 'bjb', 'dki',
                    // Bank Syariah
                    'bsi', 'muamalat', 'bca_syar', 'bni_syar', 'bri_syar',
                    'mandiri_syar', 'cimb_syar', 'danamon_syar',
                    // Bank Digital
                    'jago', 'jenius', 'seabank', 'bcad',
                    // E-Wallet
                    'gopay', 'ovo', 'shopeepay', 'dana', 'linkaja'
                ];

                if (!validBanks.includes(kodeBank.toLowerCase())) {
                    // Beri saran bank yang mirip jika tidak ditemukan
                    const similarBanks = validBanks.filter(bank => 
                        bank.includes(kodeBank.toLowerCase()) || 
                        kodeBank.toLowerCase().includes(bank)
                    );
                    
                    let errorMessage = `❌ Kode bank "${kodeBank}" tidak valid.\n\n`;
                    errorMessage += `*Bank yang tersedia:*\n`;
                    
                    // Kelompokkan bank untuk tampilan yang lebih rapi
                    errorMessage += `• *Bank Umum:* bca, bni, mandiri, bri, cimb, danamon, permata, panin\n`;
                    errorMessage += `• *Bank Syariah:* bsi, muamalat, bca_syar, bni_syar\n`;
                    errorMessage += `• *Bank Digital:* jago, jenius, seabank\n`;
                    errorMessage += `• *E-Wallet:* gopay, ovo, shopeepay, dana\n\n`;
                    
                    if (similarBanks.length > 0) {
                        errorMessage += `Mungkin maksud Anda: ${similarBanks.join(', ')}`;
                    } else {
                        errorMessage += `Gunakan kode bank sesuai daftar di atas.`;
                    }
                    
                    return ctx.reply(errorMessage, { parse_mode: 'Markdown' });
                }

                // Validasi nominal
                const nominal = parseInt(nominalStr.replace(/\D/g, ''));
                if (isNaN(nominal)) {
                    return ctx.reply('❌ Nominal harus berupa angka.');
                }
                if (nominal < 10000) {
                    return ctx.reply('❌ Nominal minimal Rp 10.000');
                }
                if (nominal > 100000000) {
                    return ctx.reply('❌ Nominal maksimal Rp 100.000.000');
                }

                // Validasi nomor rekening (hanya angka)
                const cleanedNomorAkun = nomorAkun.replace(/\D/g, '');
                if (cleanedNomorAkun.length < 8) {
                    return ctx.reply('❌ Nomor rekening minimal 8 digit');
                }
                if (cleanedNomorAkun.length > 16) {
                    return ctx.reply('❌ Nomor rekening maksimal 16 digit');
                }

                // Validasi nama penerima
                if (namaPemilik.length < 3) {
                    return ctx.reply('❌ Nama penerima minimal 3 karakter');
                }
                if (namaPemilik.length > 50) {
                    return ctx.reply('❌ Nama penerima maksimal 50 karakter');
                }

                // Simpan data ke userState
                userState.transferData = {
                    kodeBank: kodeBank.toLowerCase(),
                    nomorAkun: cleanedNomorAkun,
                    namaPemilik: namaPemilik,
                    nominal: nominal,
                    refId: refId || '', // Bisa kosong, nanti dibuat otomatis
                    email: '',
                    phone: '',
                    note: ''
                };

                // Lanjut ke step email (opsional)
                userState.step = 'optional_email';
                
                // Tampilkan info bank yang dipilih
                const bankNames = {
                    'bca': 'Bank Central Asia',
                    'bni': 'Bank Negara Indonesia',
                    'mandiri': 'Bank Mandiri',
                    'bri': 'Bank Rakyat Indonesia',
                    'cimb': 'CIMB Niaga',
                    'danamon': 'Bank Danamon',
                    'permata': 'Bank Permata',
                    'panin': 'Panin Bank',
                    'ocbc': 'OCBC NISP',
                    'maybank': 'Maybank',
                    'btn': 'BTN',
                    'bukopin': 'Bank Bukopin',
                    'bjb': 'Bank Jabar Banten',
                    'dki': 'Bank DKI',
                    'bsi': 'Bank Syariah Indonesia',
                    'muamalat': 'Bank Muamalat',
                    'bca_syar': 'BCA Syariah',
                    'bni_syar': 'BNI Syariah',
                    'bri_syar': 'BRI Syariah',
                    'mandiri_syar': 'Mandiri Syariah',
                    'cimb_syar': 'CIMB Syariah',
                    'danamon_syar': 'Danamon Syariah',
                    'jago': 'Bank Jago',
                    'jenius': 'Jenius',
                    'seabank': 'SeaBank',
                    'bcad': 'BCA Digital',
                    'gopay': 'GoPay',
                    'ovo': 'OVO',
                    'shopeepay': 'ShopeePay',
                    'dana': 'DANA',
                    'linkaja': 'LinkAja'
                };
                
                const bankName = bankNames[kodeBank.toLowerCase()] || kodeBank.toUpperCase();
                
                return ctx.reply(
                    `✅ *Data Transfer Diterima*\n\n` +
                    `📋 **Detail Transfer:**\n` +
                    `• Bank: **${bankName}**\n` +
                    `• Rekening: **${cleanedNomorAkun}**\n` +
                    `• Penerima: **${namaPemilik}**\n` +
                    `• Nominal: **Rp ${nominal.toLocaleString('id-ID')}**\n\n` +
                    `📧 *Email Penerima (Opsional)*\n` +
                    `Kirim email penerima atau ketik \`skip\` untuk melanjutkan.`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: Markup.inlineKeyboard([
                            Markup.button.callback('⬅️ Batalkan', 'admin_menu')
                        ]).reply_markup
                    }
                );
            }
            
            // Step 2: Email (opsional)
            else if (userState.step === 'optional_email') {
                if (text.toLowerCase() === 'skip') {
                    userState.transferData.email = '';
                } else {
                    // Validasi email sederhana
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(text)) {
                        return ctx.reply(
                            '❌ Format email tidak valid. Contoh: user@example.com\nKirim email valid atau ketik `skip`',
                            { parse_mode: 'Markdown' }
                        );
                    }
                    userState.transferData.email = text;
                }
                
                userState.step = 'optional_phone';
                
                return ctx.reply(
                    `📱 *Nomor Telepon (Opsional)*\n\n` +
                    `Kirim nomor telepon penerima (contoh: 081234567890) atau ketik \`skip\` untuk melanjutkan.`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: Markup.inlineKeyboard([
                            Markup.button.callback('⬅️ Batalkan', 'admin_menu')
                        ]).reply_markup
                    }
                );
            }
            
            // Step 3: Nomor telepon (opsional)
            else if (userState.step === 'optional_phone') {
                if (text.toLowerCase() === 'skip') {
                    userState.transferData.phone = '';
                } else {
                    const phone = text.replace(/\D/g, '');
                    if (phone.length < 10 || phone.length > 15) {
                        return ctx.reply('❌ Nomor telepon harus 10-15 digit angka. Kirim valid atau ketik `skip`');
                    }
                    userState.transferData.phone = phone;
                }
                
                userState.step = 'optional_note';
                
                return ctx.reply(
                    `📝 *Catatan (Opsional)*\n\n` +
                    `Kirim catatan untuk transfer (maks 100 karakter) atau ketik \`skip\` untuk melanjutkan.`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: Markup.inlineKeyboard([
                            Markup.button.callback('⬅️ Batalkan', 'admin_menu')
                        ]).reply_markup
                    }
                );
            }
            
            // Step 4: Catatan (opsional)
            else if (userState.step === 'optional_note') {
                if (text.toLowerCase() === 'skip') {
                    userState.transferData.note = '';
                } else {
                    userState.transferData.note = text.substring(0, 100);
                }

                // Semua data sudah terkumpul, tampilkan konfirmasi
                const data = userState.transferData;
                
                // Generate refId otomatis jika kosong
                if (!data.refId || data.refId.trim() === '') {
                    data.refId = `TF${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
                }
                
                // Bank name mapping
                const bankNames = {
                    'bca': 'Bank Central Asia',
                    'bni': 'Bank Negara Indonesia',
                    'mandiri': 'Bank Mandiri',
                    'bri': 'Bank Rakyat Indonesia',
                    'cimb': 'CIMB Niaga',
                    'danamon': 'Bank Danamon',
                    'permata': 'Bank Permata',
                    'panin': 'Panin Bank',
                    'ocbc': 'OCBC NISP',
                    'maybank': 'Maybank',
                    'btn': 'BTN',
                    'bukopin': 'Bank Bukopin',
                    'bjb': 'Bank Jabar Banten',
                    'dki': 'Bank DKI',
                    'bsi': 'Bank Syariah Indonesia',
                    'muamalat': 'Bank Muamalat',
                    'bca_syar': 'BCA Syariah',
                    'bni_syar': 'BNI Syariah',
                    'bri_syar': 'BRI Syariah',
                    'mandiri_syar': 'Mandiri Syariah',
                    'cimb_syar': 'CIMB Syariah',
                    'danamon_syar': 'Danamon Syariah',
                    'jago': 'Bank Jago',
                    'jenius': 'Jenius',
                    'seabank': 'SeaBank',
                    'bcad': 'BCA Digital',
                    'gopay': 'GoPay',
                    'ovo': 'OVO',
                    'shopeepay': 'ShopeePay',
                    'dana': 'DANA',
                    'linkaja': 'LinkAja'
                };
                
                const bankName = bankNames[data.kodeBank] || data.kodeBank.toUpperCase();
                
                const confirmMessage = `✅ *Konfirmasi Data Transfer*\n\n` +
                    `📋 **Detail Transfer:**\n` +
                    `• Ref ID: \`${data.refId}\`\n` +
                    `• Bank: **${bankName}**\n` +
                    `• Rekening: **${data.nomorAkun}**\n` +
                    `• Penerima: **${data.namaPemilik}**\n` +
                    `• Nominal: **Rp ${data.nominal.toLocaleString('id-ID')}**\n` +
                    (data.email ? `• Email: ${data.email}\n` : '') +
                    (data.phone ? `• Telepon: ${data.phone}\n` : '') +
                    (data.note ? `• Catatan: ${data.note}\n` : '') +
                    `\n**Apakah data sudah benar?**\n` +
                    `_Klik 'Ya' untuk melanjutkan transfer._`;

                userState.step = 'confirmation';
                
                await ctx.reply(confirmMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Ya, Proses Transfer', `confirm_transfer_yes`),
                            Markup.button.callback('❌ Batal', `confirm_transfer_no`)
                        ]
                    ]).reply_markup
                });
            }
        }
        
    } catch (error) {
        console.error("Error processing admin text:", error);
        ctx.reply("❌ Terjadi kesalahan saat memproses permintaan Anda.");
        delete userStates[userId];
    }
});

bot.catch((err, ctx) => {
    const desc = String((err && (err.description || err.message)) || err || '');
    console.error(`[bot.catch] type=${ctx && ctx.updateType} user=${ctx && ctx.from && ctx.from.id}: ${desc}`);
    // Error Telegram berikut bukan kegagalan nyata (tombol lama, pesan sudah dihapus,
    // isi pesan sama, user memblokir bot) -> jangan tampilkan "kesalahan internal".
    const benign = [
        'message is not modified', 'query is too old', 'query ID is invalid',
        'message to edit not found', 'message to delete not found', "message can't be deleted",
        'MESSAGE_ID_INVALID', 'message to be replied not found', 'bot was blocked by the user',
        'user is deactivated', 'chat not found', 'Forbidden', "can't parse entities",
    ];
    if (benign.some((s) => desc.includes(s))) return;
    try {
        if (ctx && typeof ctx.reply === 'function') {
            ctx.reply('❌ Maaf, terjadi kesalahan internal. Silakan coba lagi nanti.').catch(() => {});
        }
    } catch (e) {
        console.error("Fatal error: Can't send error message to user.", e);
    }
});

bot.command('caraorder', async (ctx) => {
    const message = `❓ *Cara Melakukan Pemesanan*\n\n` + `1. Mulai bot dengan perintah /start.\n` + `2. Klik tombol *"Daftar Produk"*.\n` + `3. Pilih produk yang Anda inginkan dari daftar.\n` + `4. Pilih varian produk yang tersedia.\n` + `5. Atur jumlah yang ingin dibeli, lalu klik *"Lanjut ke Pembayaran"*.\n` + `6. Pilih metode pembayaran (QRIS atau DANA) dan selesaikan pembayaran sesuai instruksi.\n\n` + `Stok akan otomatis dikirimkan setelah pembayaran berhasil.`;
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.command('refund', async (ctx) => {
    const message = `🧮 *Kalkulator Refund*\n\n` + `Fitur ini sedang dalam pengembangan dan belum tersedia saat ini. ` + `Untuk permintaan refund, silakan hubungi admin secara langsung.`;
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ===== Perintah OWNER: cek akun DigitalOcean, preview, & pemulihan kirim =====
bot.command('cekdo', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    await ctx.reply('🔍 Memulai pengecekan akun DigitalOcean di stok...');
    try {
        const result = await docheck.runDigitalOceanCheck(bot);
        if (result && result.skipped) await ctx.reply('⏳ Pengecekan lain sedang berjalan.');
        else if (result && typeof result.checked === 'number') await ctx.reply(`✅ Selesai.\nDicek: ${result.checked}\nLocked (dihapus): ${result.removed}\nInvalid: ${result.invalid}`);
        else await ctx.reply('✅ Pengecekan selesai.');
    } catch (err) { await ctx.reply(`❌ Gagal: ${err.message}`); }
});

bot.command('preview', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    const raw = ctx.message.text.replace(/^\/preview(@\w+)?\s*/i, '').trim();
    if (raw) {
        const formatted = formatItemsForCustomer([raw]);
        return ctx.reply(`👁️ *Preview Tampilan ke Customer*\n\n` + "```\n" + `PRODUK\n${formatted}` + "\n```", { parse_mode: 'Markdown' });
    }
    try {
        const products = await Product.find().lean();
        for (const product of products) {
            for (const variant of product.variants || []) {
                const stock = variant.stock || [];
                if (stock.length > 0) {
                    const formatted = formatItemsForCustomer([stock[0]]);
                    return ctx.reply(`👁️ *Preview Tampilan ke Customer*\n(${product.name} - ${variant.name})\n\n` + "```\n" + `${product.name.toUpperCase()}\n${formatted}` + "\n```", { parse_mode: 'Markdown' });
                }
            }
        }
        return ctx.reply('Tidak ada stok. Coba: `/preview id|password|note|note`', { parse_mode: 'Markdown' });
    } catch (err) { return ctx.reply(`❌ Gagal: ${err.message}`); }
});

bot.command('belumkirim', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    try {
        const orders = await Order.find({ status: 'PAID', delivered: { $ne: true } }).sort({ paidAt: -1 }).limit(30).lean();
        if (orders.length === 0) return ctx.reply('✅ Tidak ada order yang belum terkirim.');
        const lines = [`⚠️ *${orders.length} order sudah dibayar tapi akun belum terkirim:*`, ''];
        orders.forEach((o, i) => {
            const when = o.paidAt ? moment(o.paidAt).tz('Asia/Jakarta').format('DD/MM HH:mm') : '-';
            const kosong = !o.reservedItems || o.reservedItems.length === 0 ? ' • ⚠️ akun belum ada (kirim manual)' : '';
            lines.push(`${i + 1}. \`${o.orderId}\`\n   ${escapeMd(o.productName)} - ${escapeMd(o.variantName)} (${o.quantity}x) • user ${o.customerInfo?.telegramUserId} • ${when}${kosong}`);
        });
        lines.push('', 'Kirim ulang dengan: `/resend <ID_ORDER>`', 'Sudah dikirim manual? Tandai: `/tandaikirim <ID_ORDER>`');
        const text = lines.join('\n');
        await ctx.reply(text, { parse_mode: 'Markdown' })
            .catch(() => ctx.reply(text.replace(/\\([_*`\[])/g, '$1').replace(/[*`]/g, '')));
    } catch (err) { await ctx.reply(`❌ Gagal: ${err.message}`); }
});

// Tandai order sudah terkirim (mis. akun dikirim manual oleh owner). Khusus owner.
bot.command('tandaikirim', async (ctx) => {
    if (!ownerIdList().includes(String(ctx.from.id))) return;
    const orderId = ctx.message.text.replace(/^\/tandaikirim(@\w+)?\s*/i, '').trim();
    if (!orderId) return ctx.reply('Format: /tandaikirim <ID_ORDER>\nLihat daftar dengan /belumkirim');
    const r = await Order.updateOne({ orderId, status: 'PAID' }, { $set: { delivered: true, deliveredAt: new Date() } });
    return ctx.reply(r.matchedCount ? `✅ Order ${orderId} ditandai sudah terkirim.` : `❌ Order ${orderId} tidak ditemukan / belum lunas.`);
});

// Kirim ulang akun ke customer untuk order tertentu (khusus owner).
bot.command('resend', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    const orderId = ctx.message.text.replace(/^\/resend(@\w+)?\s*/i, '').trim();
    if (!orderId) return ctx.reply('Format: `/resend <ID_ORDER>`', { parse_mode: 'Markdown' });
    try {
        const order = await Order.findOne({ orderId }).lean();
        if (!order) return ctx.reply('❌ Order tidak ditemukan.');
        if (order.status !== 'PAID') return ctx.reply(`❌ Status order = ${order.status} (bukan PAID).`);
        if (!order.reservedItems || order.reservedItems.length === 0) return ctx.reply('❌ Data akun order ini sudah kosong (lewat masa retensi).');
        const ok = await deliverAccountsToCustomer(order, String(order.paymentGateway || '').toLowerCase() === 'dana' ? 'DANA' : 'QRIS');
        await ctx.reply(ok ? `✅ Akun order \`${orderId}\` berhasil dikirim ulang.` : `❌ Masih gagal kirim untuk \`${orderId}\`. Cek apakah bot diblokir user.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ Gagal: ${err.message}`); }
});

// =================================================================
// BAGIAN C: TITIK MULAI APLIKASI (LAUNCHER)
// =================================================================

bot.telegram.setMyCommands([
    { command: 'start', description: 'Memulai atau restart bot' },
    { command: 'stock', description: 'Cek stok produk yang tersedia' },
    { command: 'caraorder', description: 'Cara melakukan pemesanan' }
]).then(() => {
    console.log('Menu perintah berhasil diatur.');
}).catch(err => {
    console.error('Gagal mengatur menu perintah:', err);
});

// Jalankan Admin Panel Express
app.listen(PORT, () => {
    console.log(`✅ Admin panel berjalan di http://localhost:${PORT}`);
});

// Jalankan Telegram Bot
bot.launch().then(() => {
    console.log('✅ Bot Telegram berhasil terhubung dan berjalan...');
}).catch(err => {
    console.error('❌ Error saat menjalankan bot:', err);
});

// Pembersihan storage: sekali saat start (ditunda 30 detik agar koneksi DB
// dan pembuatan index selesai dulu), lalu berkala.
setTimeout(runStorageMaintenance, 30 * 1000);
setInterval(runStorageMaintenance, MAINTENANCE_INTERVAL_HOURS * 60 * 60 * 1000);

// Pengecekan akun DigitalOcean di stok: 60 detik setelah start, lalu tiap 1 jam.
// Akun locked otomatis dihapus dari stok & dilaporkan ke OWNER_ID.
setTimeout(() => docheck.runDigitalOceanCheck(bot), 60 * 1000);
setInterval(() => docheck.runDigitalOceanCheck(bot), docheck.CHECK_INTERVAL_MS);

// Rekonsiliasi order Pakasir yang mungkin dibayar saat bot mati (ditunda 20 detik).
setTimeout(sweepPakasirOrders, 20 * 1000);
if (ADMIN_DEFAULT_LOGIN) {
    setTimeout(() => {
        for (const id of ownerIdList()) {
            bot.telegram.sendMessage(id,
                '⚠️ Login panel web masih memakai gen/gen (tidak aman).\n' +
                'Isi ADMIN_USERNAME dan ADMIN_PASSWORD di Environment Render, lalu deploy ulang.'
            ).catch(() => {});
        }
    }, 25 * 1000);
}
// Cek ulang berkala: pembayaran telat / setelah restart tetap diproses.
setInterval(sweepPakasirOrders, 2 * 60 * 1000);

// Jaring pengaman: error tak tertangkap tidak mematikan seluruh bot, cukup dilaporkan.
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
    const owners = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    const msg = (reason && reason.message) ? reason.message : String(reason);
    for (const o of owners) bot.telegram.sendMessage(o, `⚠️ [BOT] Unhandled rejection:\n${msg}`).catch(() => {});
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    const owners = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    for (const o of owners) bot.telegram.sendMessage(o, `⚠️ [BOT] Uncaught exception:\n${err.message}`).catch(() => {});
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
