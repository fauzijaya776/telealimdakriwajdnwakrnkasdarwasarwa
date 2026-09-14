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
// === 2. INISIALISASI & KONEKSI DATABASE ===
connectDB(); 

// Inisialisasi Express App dan Telegraf Bot
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const GROUP_NOTIF_ID = process.env.GROUP_NOTIF_ID;

// Ambil userStates dari modul admin dan inisialisasi sesi pembayaran
const { userStates } = adminModule;
const paymentSessions = new Map();

// -----------------------------------------------------------------
// FORMAT TAMPILAN AKUN UNTUK CUSTOMER
// Khusus produk DigitalOcean: item disimpan sebagai
//   dop_v1xxx|email|password|2fa   (pisah '|', 2fa opsional)
// Ditampilkan berlabel rapi:
//   api key = ...
//   email = ...
//   password = ...
//   2fa = ...
// Item produk lain ditampilkan apa adanya (tidak diubah).
// -----------------------------------------------------------------
function formatAccountItem(item) {
    if (!item || typeof item !== 'string') return item;
    const allLines = item.split(/\r?\n/);
    const firstLine = allLines[0];
    const extra = allLines.slice(1).filter((l) => l.trim()); // baris tambahan (kalau ada)

    // --- Produk DigitalOcean: tampilkan berlabel ---
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

    // --- Produk biasa: pecah tiap bagian pembatas '|' ke baris sendiri ---
    if (firstLine.includes('|')) {
        const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
        const out = [...parts];
        if (extra.length) out.push(...extra);
        return out.join('\n');
    }

    // --- Tidak ada pembatas: biarkan apa adanya ---
    return item;
}

// Untuk pesan chat (di dalam code block). Beri nomor bila lebih dari 1 item.
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

// Untuk file .txt (pembelian jumlah banyak). Tiap akun dipisah baris kosong.
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

        for (const order of stranded) {
            try {
                await Product.updateOne(
                    { id: order.productId, 'variants.slug': order.variantSlug },
                    {
                        $push: { 'variants.$.stock': { $each: order.reservedItems } },
                        $pull: { 'variants.$.reserved_stock': { $in: order.reservedItems } }
                    }
                );
                await Order.updateOne(
                    { _id: order._id, status: 'PENDING' },
                    { $set: { status: 'EXPIRED' } }
                );
            } catch (itemError) {
                console.error(`Gagal memulihkan stok order ${order.orderId}:`, itemError.message);
            }
        }
        if (stranded.length > 0) {
            console.log(`♻️  Maintenance: stok dari ${stranded.length} order nyangkut dikembalikan.`);
        }

        const junkCutoff = new Date(Date.now() - JUNK_ORDER_TTL_HOURS * 60 * 60 * 1000);
        const deleted = await Order.deleteMany({
            status: { $ne: 'PAID' },
            createdAt: { $lt: junkCutoff }
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

    try {
        // 1. Format Pesan Notifikasi
        const message = [
            '✅ *Transaksi Baru Berhasil*',
            `*Waktu:* ${moment(order.paidAt).tz('Asia/Jakarta').format('HH:mm DD/MM/YY')}`,
            `*User:* @${order.customerInfo.first_name} (${order.customerInfo.telegramUserId})`,
            `*Produk:* ${order.productName} - ${order.variantName}`,
            `*Jumlah:* ${order.quantity}x`,
            `*Total:* Rp ${order.amount.toLocaleString('id-ID')}`,
            `*Metode:* ${order.paymentGateway.toUpperCase()}`,
            `*ID Order:* ${order.orderId}`
        ].join('\n');

        await bot.telegram.sendMessage(GROUP_NOTIF_ID, message, { parse_mode: 'Markdown' });

        // 2. Buat dan Kirim File .txt
        const fileContent = formatItemsForFile(order.reservedItems);
        const fileName = `akun_${order.orderId}.txt`;

        await bot.telegram.sendDocument(
            GROUP_NOTIF_ID,
            { source: Buffer.from(fileContent, 'utf-8'), filename: fileName },
            { caption: `Akun untuk order ${order.orderId}` }
        );

    } catch (error) {
        console.error(`Gagal mengirim notifikasi admin untuk order ${order.orderId}:`, error);
    }
}

// =================================================================
// PENGIRIMAN AKUN KE CUSTOMER — TAHAN BANTING
// Menangani kasus "sudah bayar tapi akun tidak terkirim":
//   1. Kirim pakai Markdown. Kalau gagal (mis. karakter merusak format
//      Markdown), coba ulang sebagai teks biasa.
//   2. Kalau tetap gagal (mis. customer blokir bot), LAPOR ke OWNER
//      lengkap dengan file akunnya supaya bisa dikirim manual, dan order
//      TIDAK ditandai terkirim (delivered tetap false) untuk audit.
//   3. Kalau sukses, tandai order delivered=true.
// Fungsi ini TIDAK PERNAH melempar error (aman dipanggil di dalam polling).
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

async function alertOwnerDeliveryFailed(order, reason) {
    const owners = ownerIdList();
    if (owners.length === 0) return;
    const head = [
        '🚨 *GAGAL KIRIM AKUN KE CUSTOMER*',
        '',
        `Order \`${order.orderId}\` sudah *DIBAYAR* tetapi akun *GAGAL terkirim*.`,
        `User: \`${order.customerInfo?.telegramUserId || '-'}\``,
        `Produk: ${order.productName} - ${order.variantName}`,
        `Jumlah: ${order.quantity}x`,
        `Sebab: ${reason}`,
        '',
        `Kirim manual akun di file berikut, lalu jalankan \`/resend ${order.orderId}\` bila customer sudah bisa menerima.`,
    ].join('\n');
    const fileContent = formatItemsForFile(order.reservedItems || []);
    for (const o of owners) {
        await bot.telegram.sendMessage(o, head, { parse_mode: 'Markdown' }).catch(() => {});
        await bot.telegram.sendDocument(
            o,
            { source: Buffer.from(fileContent || '(kosong)', 'utf-8'), filename: `BELUM_TERKIRIM_${order.orderId}.txt` },
            { caption: `Akun order ${order.orderId} (belum terkirim ke customer)` }
        ).catch(() => {});
    }
}

// Kirim satu pesan: coba Markdown dulu, fallback ke teks biasa.
// Melempar error hanya jika teks biasa pun gagal (mis. bot diblokir).
async function sendMessageWithFallback(chatId, markdownMsg) {
    try {
        await bot.telegram.sendMessage(chatId, markdownMsg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.warn(`[DELIVERY] Markdown gagal (${e.message}), coba teks biasa...`);
        const plain = markdownMsg.replace(/```/g, '').replace(/[*_`]/g, '');
        await bot.telegram.sendMessage(chatId, plain); // tanpa parse_mode
    }
}

async function deliverAccountsToCustomer(order, methodLabel) {
    const chatId = order.customerInfo?.telegramUserId;
    if (!chatId) {
        await alertOwnerDeliveryFailed(order, 'telegramUserId customer kosong');
        return false;
    }

    // Ambil SNK produk (kalau ada).
    let snk = null;
    try {
        const product = await Product.findOne({ id: order.productId });
        const variant = product ? product.variants.find((v) => v.slug === order.variantSlug) : null;
        snk = variant && variant.snk ? variant.snk : null;
    } catch (e) { /* abaikan, SNK opsional */ }
    const hasSnk = snk && snk.trim() !== '' && snk.trim() !== '-';

    const infoLine =
        `*Info Pembelian:*\n– Total: Rp ${Number(order.amount).toLocaleString('id-ID')}\n` +
        `– Metode: ${methodLabel}\n– ID Transaksi: \`${order.orderId}\``;

    try {
        if (order.quantity < 10) {
            const formattedItems = formatItemsForCustomer(order.reservedItems);
            let msg = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n${infoLine}\n\n` +
                "```\n" + `${order.productName.toUpperCase()}\n${formattedItems}` + "\n```";
            if (hasSnk) msg += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
            await sendMessageWithFallback(chatId, msg);
        } else {
            let msg = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n${infoLine}\n\n` +
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

        await markOrderDelivered(order.orderId);
        if (GROUP_NOTIF_ID) await sendAdminNotification(bot, order).catch(() => {});
        return true;
    } catch (err) {
        console.error(`[DELIVERY] GAGAL kirim akun order ${order.orderId}:`, err.message);
        await alertOwnerDeliveryFailed(order, err.message || String(err));
        return false;
    }
}

async function handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId) {
    // Fungsi ini dipanggil jika pembuatan invoice gagal SETELAH stok berhasil dicadangkan.
    if (reservedItems && reservedItems.length > 0) {
        console.log(`[RECOVERY] Error saat membuat invoice untuk order ${internalOrderId}. Mengembalikan ${reservedItems.length} item stok.`);
        try {
            // 1. Kembalikan stok yang dicadangkan ke stok utama
            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug },
                {
                    $pull: { "variants.$.reserved_stock": { $in: reservedItems } }, // Tarik dari reserved_stock
                    $push: { "variants.$.stock": { $each: reservedItems } }      // Masukkan kembali ke stock
                }
            );

            // 2. Tandai pesanan sebagai GAGAL di database
            await Order.updateOne(
                // Mencari berdasarkan ID internal yang unik untuk semua gateway
                { $or: [{ orderId: internalOrderId }, { internalRefId: internalOrderId }] },
                { $set: { status: 'FAILED' } }
            );
            console.log(`[RECOVERY] Stok untuk order ${internalOrderId} berhasil dikembalikan.`);
        } catch (recoveryError) {
            console.error(`[FATAL RECOVERY ERROR] Gagal mengembalikan stok untuk order ${internalOrderId}:`, recoveryError);
            // Di sini bisa ditambahkan notifikasi ke admin jika recovery gagal total
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
// verify: simpan body mentah untuk validasi tanda tangan webhook QRIN (HMAC atas raw body).
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(session({
    secret: 'telegram-bot-admin-secret-key-super-aman',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 60 * 60 * 1000 }
}));

const ADMIN_USERNAME = 'gen';
const ADMIN_PASSWORD = 'gen';

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
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.loggedin = true;
        req.session.user = { username };
        res.redirect('/');
    } else {
        res.redirect('/login?error=Invalid username or password');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- Rute API untuk MENGAMBIL stok ---
// =================================================================
// CATATAN KEAMANAN
// =================================================================
// Route `/api/take-stock` dan `/api/return-stock` DIHAPUS.
//
// Keduanya tidak punya authMiddleware sama sekali, padahal route admin lain
// punya. Artinya siapa pun yang tahu alamat server ini bisa menguras seluruh
// stok lewat satu request HTTP, tanpa login.
//
// Penggantinya: menu "📤 Ambil Stok" di panel admin Telegram, yang dijaga
// adminMiddleware (hanya ID di OWNER_ID) dan memakai transaksi MongoDB
// sehingga aman dari race condition dengan pembelian customer.

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
    const updatedStockList = req.body.current_stock.split(/\r?\n/).filter(line => line.trim() !== '');
    await Product.updateOne(
        { id: req.params.id, "variants.slug": req.params.slug },
        { $set: { "variants.$.stock": updatedStockList } }
    );
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
    const { broadcast_type, content, image_url, image_source, include_buttons } = req.body;
    // Checkbox "Sertakan tombol" -> lampirkan tombol inline (Lihat Produk / Cek
    // Stok / Riwayat) di bawah pesan promo, sama seperti /start.
    const buttonExtra = include_buttons ? { reply_markup: getPromoInlineKeyboard().reply_markup } : {};
    try {
        const users = await User.find({}, 'id');
        const userIds = users.map(user => user.id);
        let successCount = 0;
        let failCount = 0;
        for (const userId of userIds) {
            try {
                if (broadcast_type === 'text_only') {
                    await bot.telegram.sendMessage(userId, content, { parse_mode: 'Markdown', ...buttonExtra });
                } else if (broadcast_type === 'image_with_text') {
                    let imageToSend = (image_source === 'url') ? image_url : { source: path.join(__dirname, 'public', 'uploads', req.file.filename) };
                    await bot.telegram.sendPhoto(userId, imageToSend, { caption: content, parse_mode: 'Markdown', ...buttonExtra });
                }
                successCount++;
            } catch (e) {
                console.error(`Failed to send broadcast to ${userId}:`, e.message);
                failCount++;
            }
        }
        if (req.file) {
            await fs.unlink(req.file.path);
        }
        res.redirect(`/broadcast?success=Broadcast sent to ${successCount} users. Failed for ${failCount} users.`);
    } catch (error) {
        console.error('Broadcast error:', error);
        res.redirect(`/broadcast?error=An error occurred during broadcast.`);
    }
});

const assetStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'assets')),
    filename: (req, file, cb) => cb(null, req.body.asset_to_replace)
});
const assetUpload = multer({ storage: assetStorage });

app.get('/assets', authMiddleware, async (req, res) => {
    res.render('layout', {
        page: 'assets',
        body: await ejs.renderFile(path.join(__dirname, 'views/assets.ejs'), {
            success: req.query.success, error: req.query.error, locals: { success: req.query.success, error: req.query.error }
        })
    });
});

app.post('/assets/replace', authMiddleware, assetUpload.single('new_image_file'), (req, res) => {
    if (!req.file) {
        return res.redirect('/assets?error=You did not select a file to upload.');
    }
    res.redirect(`/assets?success=Successfully replaced ${req.body.asset_to_replace}`);
});

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

adminModule(bot);

// === HELPER: escape karakter spesial Markdown (legacy) ===
// FIX BUG: nama/username Telegram yang mengandung _ * ` [ ] membuat Telegram
// menolak seluruh pesan ("can't parse entities") sehingga /start gagal.
function escapeMd(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/([_*`\[\]])/g, '\\$1');
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

    const message = `👋 — Hello ${displayName} Selamat Datang Di FZI STORE\n\n` +
                    `🗓️ ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n` +
                    `*User Details :*\n` +
                    `├ ID : \`${userId}\`\n` +
                    `├ Username : @${displayUsername}\n` +
                    `└ Total Spent : ${totalSpentRp}\n\n` +
                    `*BOT Statistics*\n\n` +
                    `├ Products Sold : ${7125 + productsSoldCount} Accounts\n` +
                    `└ Total Users : ${1026 + totalUsers} Users\n\n` +
                    `Silahkan tekan tombol '🛒 List Produk'\n` +
                    `Bot Create VPS DO Via API & Ubah Vps Ke Rdp (installer rdp) @fzistorebot\n`;

    // FIX BUG: OWNER_ID yang belum diset membuat .split() melempar TypeError.
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    const isAdmin = ADMIN_IDS.includes(userId);
    const keyboardLayout = [['🛒 List Produk', '🧾 Riwayat Transaksi'], ['📦 Cek Stok']];
    if (isAdmin) keyboardLayout.push(['⚙️ Admin Panel']);

    // Tombol INLINE di bawah teks /start (mirip tombol pada /stock).
    // 'Lihat Produk' memakai action yang sudah ada (list_products_1);
    // 'Cek Stok' & 'Riwayat Transaksi' memakai action baru show_stock / show_history.
    const inlineRows = [
        [
            Markup.button.callback('🛒 Lihat Produk', 'list_products_1'),
            Markup.button.callback('📦 Cek Stok', 'show_stock'),
        ],
        [Markup.button.callback('🧾 Riwayat Transaksi', 'show_history')],
    ];
    if (isAdmin) inlineRows.push([Markup.button.callback('⚙️ Admin Panel', 'open_admin')]);

    return {
        message,
        keyboard: Markup.keyboard(keyboardLayout).resize(),
        inlineKeyboard: Markup.inlineKeyboard(inlineRows),
    };
}

// Tombol INLINE untuk pesan broadcast/promo (versi customer, tanpa tombol admin).
// Memakai action yang sama dgn /start, jadi siapa pun yang menekan langsung jalan.
function getPromoInlineKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🛒 Lihat Produk', 'list_products_1'),
            Markup.button.callback('📦 Cek Stok', 'show_stock'),
        ],
        [Markup.button.callback('🧾 Riwayat Transaksi', 'show_history')],
    ]);
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
            message += `*[${productNumber}]* ${escapeMd(String(p.name || '-').toUpperCase())}\n`;
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
        // QRIS (ALL) kini memakai Pakasir sebagai payment gateway.
        row2.push(Markup.button.callback('QRIS (ALL)', `pakasir_${productId}_${variantSlug}_${quantity}`));
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
            const { message, keyboard, inlineKeyboard } = await generateStartMessageAndKeyboard(ctx);
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
                await ctx.deleteMessage();
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
        const { message, keyboard, inlineKeyboard } = await generateStartMessageAndKeyboard(ctx);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);

        await ctx.deleteMessage();
        if (fileExists) {
            await ctx.replyWithPhoto(
                { source: imagePath },
                { caption: message, parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup }
            );
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        }
    } catch (error) {
        console.error('Error in back_to_start:', error);
    }
});

// ===== Tombol inline pada pesan /start =====
// 'Cek Stok' -> tampilkan daftar stok (pesan baru, tidak mengedit foto welcome).
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

// 'Riwayat Transaksi' -> ringkasan pembelian user (sama dgn tombol menu bawah).
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

// 'Admin Panel' (khusus admin) -> buka menu admin.
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

// Tombol angka di antara ➖ dan ➕ hanya penanda, bukan aksi. Tanpa handler,
// Telegram tidak pernah dapat balasan dan spinner-nya berputar sampai timeout.
bot.action('ignore_me', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
});

bot.action(/^show_product_([^_]+)_page_(\d+)$/, async (ctx) => {
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
        console.error('Error in show_product_details:', error);
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
                            // HEMAT STORAGE: ringkasan saja, bukan payload mentah gateway.
                            $set: { status: 'PAID', paidAt: new Date(), paymentDetails: slimPaymentDetails(statusResult) },
                            // Order lunas tidak boleh ikut terhapus TTL.
                            $unset: { expiresAt: '' }
                        },
                        { new: true }
                    );

                    if (order) {
                        await Product.updateOne({ id: order.productId, "variants.slug": order.variantSlug }, { $pull: { "variants.$.reserved_stock": { $in: order.reservedItems } } });
                        await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } });

                        // Kirim akun ke customer via helper tahan-banting
                        // (fallback teks biasa + lapor owner bila gagal).
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
    const internalOrderId = `G-${ctx.from.id}-${Date.now()}`;
    let reservedItems = [];
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
        await ctx.deleteMessage();
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

        const orderDetails = { productId, variantSlug, productName: product.name, variantName: variant.name, quantity, reservedItems };
        const customerInfo = { telegramUserId: ctx.from.id.toString(), first_name: ctx.from.first_name };

        const rawPayment = await qrin.createTransaction(internalOrderId, totalHarga, product.name);
        console.log("[QRIN] Raw payment response:", JSON.stringify(rawPayment, null, 2));

        const payment = {
            displayOrderId: rawPayment.displayOrderId,
            realOrderId: rawPayment.realOrderId,
            qrString: rawPayment.qrString,
            amount: rawPayment.amount,
            totalBayar: rawPayment.totalBayar,
            fee: rawPayment.fee,
            validity: rawPayment.validity,
        };

        if (!payment.qrString) throw new Error("QR String tidak ditemukan dari response QRIN");

        const newOrder = new Order({
            orderId: payment.displayOrderId,
            realOrderId: payment.realOrderId,
            internalRefId: internalOrderId,
            depositId: payment.realOrderId,
            amount: payment.amount,
            status: "PENDING",
            expiresAt: junkOrderExpiry(),
            ...orderDetails,
            customerInfo,
            paymentGateway: "qrin",
        });
        await newOrder.save({ session });
        await session.commitTransaction();
        transactionCommitted = true;

        const qrDataURL = await QRCode.toDataURL(payment.qrString, {
            type: 'image/png',
            width: 512,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        const qrBuffer = Buffer.from(qrDataURL.split(",")[1], "base64");

        const caption = `📁 *Invoice Berhasil Dibuat*\n\`\`\`\n${payment.displayOrderId}\n\`\`\`\n────────────✧\n*QRIS SEMUA PEMBAYARAN*\n────────────✧\n*Informasi Item:*\n— Nama: ${product.name.toUpperCase()} - ${variant.name}\n— Jumlah: ${quantity}x\n\n*Informasi Pembayaran:*\n— ID Transaksi: \`${payment.displayOrderId}\`\n— Total Dibayar: Rp ${payment.totalBayar.toLocaleString('id-ID')}\n— Kedaluwarsa dalam: 5 Menit`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Batalkan Pembelian', `cancel_payment_qrin_${payment.displayOrderId}`)]]);

        await ctx.deleteMessage().catch(() => {});
        qrPhotoMsg = await ctx.replyWithPhoto({ source: qrBuffer }, { caption, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

        // ===== MODE WEBHOOK (QRIN tidak menyediakan endpoint polling) =====
        // Konfirmasi pembayaran datang dari QRIN via POST /qrin/callback -> fulfillQrinPaidOrder().
        // Di sini kita hanya memasang timeout kedaluwarsa: bila sampai batas waktu belum ada
        // callback "success", stok dikembalikan & order ditandai EXPIRED.
        const pollDuration = 300000; // 5 menit, selaras dengan validity QRIN
        let isHandled = false;

        const handleExpiry = async () => {
            if (isHandled) return;
            isHandled = true;
            const sessionData = paymentSessions.get(payment.displayOrderId);
            if (sessionData) {
                clearTimeout(sessionData.timeoutId);
                paymentSessions.delete(payment.displayOrderId);
            }

            // Hanya kembalikan stok jika order MASIH pending (hindari bentrok dgn callback sukses).
            const expired = await Order.findOneAndUpdate(
                { orderId: payment.displayOrderId, status: 'PENDING' },
                { $set: { status: 'EXPIRED' } }
            );
            if (!expired) return; // sudah dibayar / diproses callback

            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug },
                {
                    $push: { "variants.$.stock": { $each: reservedItems } },
                    $pull: { "variants.$.reserved_stock": { $in: reservedItems } }
                }
            );

            await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            await bot.telegram.sendMessage(ctx.from.id, `📜 *Tagihan Kadaluarsa*\n\nTagihan untuk ID \`${payment.displayOrderId}\` telah kadaluarsa.`, { parse_mode: 'Markdown' }).catch(() => {});
        };

        const timeoutId = setTimeout(handleExpiry, pollDuration);
        // Simpan konteks agar handler webhook bisa memenuhi order & menghapus pesan QR.
        paymentSessions.set(payment.displayOrderId, {
            timeoutId,
            qrPhotoMsgId: qrPhotoMsg.message_id,
            chatId: ctx.chat.id,
            userId: ctx.from.id,
        });

    } catch (error) {
        console.error('[QRIN] Error in action:', error);

        if (!transactionCommitted) {
            await session.abortTransaction();
        } else {
            await handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId);
        }

        if (workingMsg) await ctx.deleteMessage(workingMsg.message_id).catch(() => {});
        await ctx.reply('❌ Maaf, terjadi kesalahan internal saat membuat invoice. Silakan coba lagi nanti.');

        // DEBUG: kirim penyebab asli ke OWNER agar mudah didiagnosa (tidak terlihat customer lain).
        const ownerId = process.env.OWNER_ID;
        if (ownerId) {
            const detail = (error && error.message) ? error.message : String(error);
            await bot.telegram.sendMessage(ownerId, `⚠️ [DEBUG QRIN] Gagal membuat invoice:\n${detail}`).catch(() => {});
        }

    } finally {
        session.endSession();
    }
});

// ===== Pemenuhan order yang sudah dibayar (dipanggil oleh webhook QRIN) =====
async function fulfillQrinPaidOrder(orderId) {
    // Kunci order: hanya proses jika masih PENDING (idempoten terhadap callback ganda).
    const order = await Order.findOneAndUpdate(
        { orderId: orderId, status: 'PENDING' },
        { $set: { status: 'PAID', paidAt: new Date() }, $unset: { expiresAt: "" } },
        { new: true }
    );
    if (!order) {
        // Bedakan: callback duplikat (order sudah PAID -> abaikan diam-diam) vs
        // pembayaran telat pada order yang sudah EXPIRED/CANCELLED (perlu cek manual).
        const existing = await Order.findOne({ orderId: orderId }).lean();
        if (existing && existing.status === 'PAID') return { ok: false, reason: 'already_paid' };
        return { ok: false, reason: 'not_pending' };
    }

    // Hentikan timeout kedaluwarsa & hapus pesan QR.
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

// =================================================================
// PAKASIR (QRIS ALL) — pengganti QRIN.
// Konfirmasi pembayaran memakai POLLING ke endpoint transactiondetail
// (Pakasir menyediakan cek status), jadi TIDAK perlu domain/callback.
// Webhook Pakasir tetap didukung sebagai cadangan (lihat route /callback).
// =================================================================
bot.action(/^pakasir_([^_]+)_(.*?)_(\d+)$/, async (ctx) => {
    let workingMsg, qrPhotoMsg;
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const quantity = parseInt(ctx.match[3]);
    const internalOrderId = `P-${ctx.from.id}-${Date.now()}`;
    let reservedItems = [];
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;

    try {
        await ctx.deleteMessage();
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

        const orderDetails = { productId, variantSlug, productName: product.name, variantName: variant.name, quantity, reservedItems };
        const customerInfo = { telegramUserId: ctx.from.id.toString(), first_name: ctx.from.first_name };

        const rawPayment = await pakasir.createTransaction(internalOrderId, totalHarga);
        console.log("[PAKASIR] Raw payment response:", JSON.stringify(rawPayment, null, 2));

        const payment = {
            displayOrderId: rawPayment.displayOrderId,   // = internalOrderId
            realOrderId: rawPayment.realOrderId,
            qrString: rawPayment.qrString,
            amount: rawPayment.amount,                   // nominal dasar (dikirim ke Pakasir)
            totalBayar: rawPayment.totalBayar,           // yang dibayar customer
            fee: rawPayment.fee,
        };

        if (!payment.qrString) throw new Error("QR String tidak ditemukan dari response Pakasir");

        const newOrder = new Order({
            orderId: payment.displayOrderId,
            realOrderId: payment.realOrderId,
            internalRefId: internalOrderId,
            depositId: payment.realOrderId,
            amount: totalHarga,           // nominal dasar -> dipakai polling & statistik
            status: "PENDING",
            expiresAt: junkOrderExpiry(),
            ...orderDetails,
            customerInfo,
            paymentGateway: "pakasir",
        });
        await newOrder.save({ session });
        await session.commitTransaction();
        transactionCommitted = true;

        const qrDataURL = await QRCode.toDataURL(payment.qrString, {
            type: 'image/png', width: 512, margin: 2, errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        const qrBuffer = Buffer.from(qrDataURL.split(",")[1], "base64");

        const caption = `📁 *Invoice Berhasil Dibuat*\n\`\`\`\n${payment.displayOrderId}\n\`\`\`\n────────────✧\n*QRIS SEMUA PEMBAYARAN*\n────────────✧\n*Informasi Item:*\n— Nama: ${product.name.toUpperCase()} - ${variant.name}\n— Jumlah: ${quantity}x\n\n*Informasi Pembayaran:*\n— ID Transaksi: \`${payment.displayOrderId}\`\n— Total Dibayar: Rp ${Number(payment.totalBayar).toLocaleString('id-ID')}\n— Kedaluwarsa dalam: 5 Menit`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('Batalkan Pembelian', `cancel_payment_pakasir_${payment.displayOrderId}`)]]);

        await ctx.deleteMessage().catch(() => {});
        qrPhotoMsg = await ctx.replyWithPhoto({ source: qrBuffer }, { caption, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

        // ===== KONFIRMASI VIA POLLING (tiap 5 detik, maks 5 menit) =====
        const pollInterval = 5000;
        const pollDuration = 300000; // 5 menit
        let isHandled = false;
        const startedAt = Date.now();

        const finish = async () => {
            const s = paymentSessions.get(payment.displayOrderId);
            if (s) {
                clearInterval(s.pollingId);
                clearTimeout(s.timeoutId);
                paymentSessions.delete(payment.displayOrderId);
            }
        };

        const handleExpiry = async () => {
            if (isHandled) return;
            isHandled = true;
            await finish();
            const expired = await Order.findOneAndUpdate(
                { orderId: payment.displayOrderId, status: 'PENDING' },
                { $set: { status: 'EXPIRED' } }
            );
            if (!expired) return; // sudah dibayar / diproses
            await Product.updateOne(
                { id: productId, "variants.slug": variantSlug },
                { $push: { "variants.$.stock": { $each: reservedItems } }, $pull: { "variants.$.reserved_stock": { $in: reservedItems } } }
            );
            await bot.telegram.deleteMessage(ctx.chat.id, qrPhotoMsg.message_id).catch(() => {});
            await bot.telegram.sendMessage(ctx.from.id, `📜 *Tagihan Kadaluarsa*\n\nTagihan untuk ID \`${payment.displayOrderId}\` telah kadaluarsa.`, { parse_mode: 'Markdown' }).catch(() => {});
        };

        const pollOnce = async () => {
            if (isHandled) return;
            if (Date.now() - startedAt > pollDuration) { await handleExpiry(); return; }
            try {
                const res = await pakasir.checkPaymentStatus(payment.displayOrderId, totalHarga);
                const status = String(res?.transaction?.status || '').toLowerCase();
                if (status === 'completed') {
                    if (isHandled) return;
                    isHandled = true;
                    await finish();
                    await fulfillPakasirPaidOrder(payment.displayOrderId);
                }
            } catch (e) {
                console.error('[PAKASIR] poll error:', e.message);
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
            await session.abortTransaction();
        } else {
            await handlePaymentCreationError(productId, variantSlug, reservedItems, internalOrderId);
        }
        if (workingMsg) await ctx.deleteMessage(workingMsg.message_id).catch(() => {});
        await ctx.reply('❌ Maaf, terjadi kesalahan internal saat membuat invoice. Silakan coba lagi nanti.');
        const ownerId = process.env.OWNER_ID;
        if (ownerId) {
            const detail = (error && error.message) ? error.message : String(error);
            await bot.telegram.sendMessage(ownerId, `⚠️ [DEBUG PAKASIR] Gagal membuat invoice:\n${detail}`).catch(() => {});
        }
    } finally {
        session.endSession();
    }
});

// ===== Pemenuhan order Pakasir yang sudah dibayar (dipanggil polling / webhook) =====
async function fulfillPakasirPaidOrder(orderId) {
    // Idempoten: hanya proses order yang MASIH PENDING (aman thd double polling+webhook).
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
// REKONSILIASI SAAT STARTUP (Pakasir)
// Menutup celah: kalau bot restart SETELAH customer bayar tapi SEBELUM
// polling sempat melihat "completed", order tetap PENDING dan timer
// polling-nya hilang. Saat bot menyala lagi, fungsi ini mengecek ulang
// status semua order Pakasir yang masih PENDING langsung ke Pakasir; yang
// sudah dibayar langsung dipenuhi (fulfillPakasirPaidOrder bersifat idempoten).
// =================================================================
async function reconcilePakasirPendingOrders() {
    try {
        // Cek order PENDING pakasir dalam 24 jam terakhir (invoice cuma 5 menit,
        // tapi longgar supaya pembayaran yang telat/terlewat saat bot mati tetap tertangani).
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
                const res = await pakasir.checkPaymentStatus(o.orderId, o.amount);
                const status = String(res?.transaction?.status || '').toLowerCase();
                if (status === 'completed') {
                    const r = await fulfillPakasirPaidOrder(o.orderId);
                    if (r && r.ok) {
                        fulfilled += 1;
                        console.log(`[RECONCILE] Order ${o.orderId} ternyata sudah dibayar -> dipenuhi.`);
                    }
                }
            } catch (e) {
                console.error(`[RECONCILE] gagal cek ${o.orderId}:`, e.message);
            }
            // jeda kecil supaya tidak membombardir API Pakasir
            await new Promise((r) => setTimeout(r, 500));
        }
        if (fulfilled > 0) {
            console.log(`[RECONCILE] Selesai: ${fulfilled} order dipenuhi setelah restart.`);
        }
    } catch (error) {
        console.error('[RECONCILE] Error:', error.message);
    }
}

// Handler pembatalan Pakasir. WAJIB didaftarkan SEBELUM handler generic
// cancel_payment_(.*) agar pola cancel_payment_pakasir_... tidak salah tangkap.
bot.action(/^cancel_payment_pakasir_(.*)$/, async (ctx) => {
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

// ===== Webhook / Callback QRIN =====
// Daftarkan salah satu URL ini di Setting Merchant QRIN:
//   https://DOMAIN-ANDA/callback   ATAU   https://DOMAIN-ANDA/qrin/callback
// (kedua path ditangani agar cocok dengan apa pun yang Anda isi di dashboard).
// Tanda tangan: header X-Callback-Signature = HMAC-SHA256(raw body, QRIN_TOKEN).
// Health check publik (tanpa login) untuk Render + keep-alive pinger
// (mis. UptimeRobot ping tiap ~10 menit agar Render Free tidak tidur).
app.get(['/health', '/ping'], (req, res) => res.status(200).send('OK'));

// Menangani DUA gateway pada satu route:
//  - PAKASIR : POST tanpa signature, body { order_id, status:"completed", amount, ... }
//              -> ini yang dipakai sekarang. URL webhook di dashboard Pakasir:
//                 https://fzistore.my.id/callback  (atau /pakasir/callback).
//              CATATAN: webhook Pakasir OPSIONAL — bot sudah polling status sendiri,
//              jadi pembayaran tetap terkonfirmasi walau webhook tidak diset.
//  - QRIN    : POST dengan header X-Callback-Signature, body { no_ref_merchant, status:"success" }
//              (dipertahankan agar kompatibel; sudah tidak dipakai lagi).
app.post(['/callback', '/qrin/callback', '/pakasir/callback'], async (req, res) => {
    try {
        const body = req.body || {};
        const signature = req.headers['x-callback-signature'];
        // Pakasir tidak mengirim signature dan memakai field order_id (bukan no_ref_merchant).
        const isPakasir = req.path.includes('pakasir')
            || (!signature && !body.no_ref_merchant && (body.order_id || body.status));

        // ---------------- PAKASIR (tanpa tanda tangan) ----------------
        if (isPakasir) {
            const orderId = body.order_id;
            const status = String(body.status || '').toLowerCase();
            console.log(`[PAKASIR CALLBACK] order=${orderId} status=${status}`);
            if (!orderId) return res.status(400).json({ success: false, message: 'order_id missing' });

            if (status === 'completed') {
                // Karena Pakasir tidak pakai signature, verifikasi ulang status ke
                // endpoint transactiondetail (sesuai anjuran dokumentasi) sebelum
                // memenuhi order — mencegah callback palsu.
                let verified = true;
                try {
                    const detail = await pakasir.checkPaymentStatus(orderId, body.amount);
                    verified = String(detail?.transaction?.status || '').toLowerCase() === 'completed';
                } catch (e) {
                    console.error('[PAKASIR CALLBACK] verify error:', e.message);
                    verified = false;
                }

                if (verified) {
                    const result = await fulfillPakasirPaidOrder(orderId);
                    if (!result.ok && result.reason === 'not_pending') {
                        const ownerId = process.env.OWNER_ID;
                        if (ownerId) {
                            await bot.telegram.sendMessage(ownerId, `⚠️ [PAKASIR] Pembayaran diterima untuk order \`${orderId}\` tetapi status order bukan PENDING (mungkin sudah kadaluarsa). Perlu cek manual.`, { parse_mode: 'Markdown' }).catch(() => {});
                        }
                    }
                } else {
                    console.warn(`[PAKASIR CALLBACK] status "completed" TIDAK terverifikasi utk order ${orderId} — diabaikan.`);
                }
            }
            // Pakasir cukup menerima 200.
            return res.json({ success: true });
        }

        // ---------------- QRIN (dengan tanda tangan) ----------------
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
        if (!qrin.verifyCallbackSignature(rawBody, signature)) {
            console.warn('[QRIN CALLBACK] Signature tidak valid');
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }

        const orderId = body.no_ref_merchant;
        const status = String(body.status || '').toLowerCase();
        console.log(`[QRIN CALLBACK] order=${orderId} status=${status}`);

        if (!orderId) return res.status(400).json({ success: false, message: 'no_ref_merchant missing' });

        if (status === 'success') {
            const result = await fulfillQrinPaidOrder(orderId);
            if (!result.ok && result.reason === 'not_pending') {
                const ownerId = process.env.OWNER_ID;
                if (ownerId) {
                    await bot.telegram.sendMessage(ownerId, `⚠️ [QRIN] Pembayaran diterima untuk order \`${orderId}\` tetapi status order bukan PENDING (mungkin sudah kadaluarsa). Perlu cek manual.`, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        } else if (status === 'expired' || status === 'failed') {
            console.log(`[QRIN CALLBACK] order ${orderId} -> ${status}`);
        }

        return res.json({ success: true });
    } catch (e) {
        console.error('[CALLBACK] Error:', e);
        return res.status(500).json({ success: false, message: 'internal error' });
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
// Handler pembatalan pembayaran QRIN (QRIS ALL). Session & orderId di-key
// berdasarkan displayOrderId. Didaftarkan SEBELUM handler generic di bawah agar
// pola `cancel_payment_qrin_...` tidak keliru ditangkap regex generic.
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
        if (userState.state === 'awaiting_variant_price') {
            // Admin mengetik harga baru untuk varian.
            const done = await adminModule.handleVariantPriceInput(ctx, userState);
            if (done) delete userStates[userId];
            return;

        } else if (userState.state === 'awaiting_variant_name') {
            // Admin mengetik nama baru untuk varian.
            const done = await adminModule.handleVariantNameInput(ctx, userState);
            if (done) delete userStates[userId];
            return;

        } else if (userState.state === 'awaiting_take_stock_count') {
            // Admin mengetik jumlah akun yang mau diambil.
            const done = await adminModule.handleTakeStockCount(ctx, userState);
            if (done) delete userStates[userId];
            return;

        } else if (userState.state === 'awaiting_stock') {
            const stockToAdd = ctx.message.text.split('\n').filter(line => line.trim() !== '');
            await adminModule.addStock(userState.productId, userState.variantSlug, stockToAdd, ctx);
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

            const statusMessage = await ctx.reply('Mengirim broadcast...');
            const allUsers = await User.find({}, 'id').lean();
            const userIds = allUsers.map(user => user.id);

            let successCount = 0;
            let failCount = 0;

            // Lampirkan tombol inline (Lihat Produk / Cek Stok / Riwayat) di bawah
            // pesan broadcast, sama seperti /start.
            const promoExtra = { parse_mode: 'Markdown', reply_markup: getPromoInlineKeyboard().reply_markup };
            for (const id of userIds) {
                try {
                    await ctx.telegram.sendMessage(id, message, promoExtra);
                    successCount++;
                } catch (e) {
                    failCount++;
                }
            }

            // Laporan hasil broadcast. Kegagalan meng-edit/mengirim laporan status
            // (mis. Telegram menolak edit) TIDAK boleh dianggap broadcast gagal —
            // dulu error di sini naik ke catch luar dan memunculkan notif
            // "Terjadi kesalahan" walau pengiriman sebenarnya berhasil.
            const summaryText =
                `🚀 *Broadcast Selesai*\n\n` +
                `✅ Berhasil terkirim: ${successCount} pengguna\n` +
                `❌ Gagal terkirim: ${failCount} pengguna`;
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    statusMessage.message_id,
                    null,
                    summaryText,
                    { parse_mode: 'Markdown' }
                );
            } catch (editErr) {
                console.error('Broadcast: gagal edit pesan status (diabaikan):', editErr.message);
                // Fallback: kirim laporan sebagai pesan baru, tanpa Markdown agar aman.
                await ctx.reply(
                    `🚀 Broadcast Selesai\n\n✅ Berhasil terkirim: ${successCount} pengguna\n❌ Gagal terkirim: ${failCount} pengguna`
                ).catch(() => {});
            }
            return;

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
    // Selalu catat detail asli ke log/console (ini yang berguna utk diagnosa).
    const desc = String((err && (err.description || err.message)) || err || '');
    console.error(`[bot.catch] type=${ctx && ctx.updateType} user=${ctx && ctx.from && ctx.from.id}: ${desc}`);

    // Error Telegram berikut BUKAN kegagalan nyata (mis. menekan tombol lama,
    // edit pesan yang isinya sama, pesan sudah dihapus, atau user memblokir bot).
    // Untuk kasus ini JANGAN tampilkan pesan error yang menakutkan ke user —
    // cukup diabaikan. Inilah penyebab popup "kesalahan internal" yang salah-alarm.
    const benign = [
        'message is not modified',
        'query is too old',
        'query ID is invalid',
        'message to edit not found',
        'message to delete not found',
        "message can't be deleted",
        'MESSAGE_ID_INVALID',
        'message to be replied not found',
        'bot was blocked by the user',
        'user is deactivated',
        'chat not found',
        'Forbidden',
        "can't parse entities", // pesan Markdown tidak valid -> sudah ditangani di handler masing2
    ];
    if (benign.some(s => desc.includes(s))) return;

    // Sisanya baru dianggap error nyata & diberitahukan ke user (jika memungkinkan).
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

// Trigger manual pengecekan akun DigitalOcean (khusus owner).
bot.command('cekdo', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) {
        return; // abaikan bila bukan owner
    }
    await ctx.reply('🔍 Memulai pengecekan akun DigitalOcean di stok... (hasil dikirim setelah selesai)');
    try {
        const result = await docheck.runDigitalOceanCheck(bot);
        if (result && result.skipped) {
            await ctx.reply('⏳ Pengecekan lain sedang berjalan. Coba lagi nanti.');
        } else if (result && typeof result.checked === 'number') {
            await ctx.reply(
                `✅ Selesai.\nDicek: ${result.checked}\nLocked (dihapus): ${result.removed}\nInvalid: ${result.invalid}`
            );
        } else {
            await ctx.reply('✅ Pengecekan selesai.');
        }
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`);
    }
});

// Preview tampilan akun ke customer TANPA harus membeli (khusus owner).
//   /preview                -> ambil 1 stok DigitalOcean pertama & tampilkan
//   /preview dop_v1x|a|b|c   -> tampilkan format dari teks yang diketik
bot.command('preview', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) {
        return; // abaikan bila bukan owner
    }

    const raw = ctx.message.text.replace(/^\/preview(@\w+)?\s*/i, '').trim();

    if (raw) {
        // Preview dari teks yang diketik owner.
        const formatted = formatItemsForCustomer([raw]);
        const msg = `👁️ *Preview Tampilan ke Customer*\n\n` + "```\n" + `${'PRODUK'}\n${formatted}` + "\n```";
        return ctx.reply(msg, { parse_mode: 'Markdown' });
    }

    // Tanpa argumen: ambil stok pertama yang tersedia (produk apa pun).
    try {
        const products = await Product.find().lean();
        for (const product of products) {
            for (const variant of product.variants || []) {
                const stock = variant.stock || [];
                if (stock.length > 0) {
                    const formatted = formatItemsForCustomer([stock[0]]);
                    const msg = `👁️ *Preview Tampilan ke Customer*\n(${product.name} - ${variant.name})\n\n` +
                        "```\n" + `${product.name.toUpperCase()}\n${formatted}` + "\n```";
                    return ctx.reply(msg, { parse_mode: 'Markdown' });
                }
            }
        }
        return ctx.reply('Tidak ada stok yang ditemukan. Coba ketik contohnya: `/preview id|password|note|note`', { parse_mode: 'Markdown' });
    } catch (err) {
        return ctx.reply(`❌ Gagal: ${err.message}`);
    }
});

// Daftar order yang SUDAH DIBAYAR tapi akun BELUM terkirim (khusus owner).
bot.command('belumkirim', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    try {
        const orders = await Order.find({ status: 'PAID', delivered: { $ne: true } })
            .sort({ paidAt: -1 }).limit(30).lean();
        if (orders.length === 0) {
            return ctx.reply('✅ Tidak ada order yang belum terkirim. Semua akun sudah sampai ke customer.');
        }
        const lines = [`⚠️ *${orders.length} order sudah dibayar tapi akun belum terkirim:*`, ''];
        orders.forEach((o, i) => {
            const when = o.paidAt ? moment(o.paidAt).tz('Asia/Jakarta').format('DD/MM HH:mm') : '-';
            lines.push(`${i + 1}. \`${o.orderId}\`\n   ${o.productName} - ${o.variantName} (${o.quantity}x) • user ${o.customerInfo?.telegramUserId} • ${when}`);
        });
        lines.push('', 'Kirim ulang dengan: `/resend <ID_ORDER>`');
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`);
    }
});

// Kirim ulang akun ke customer untuk order tertentu (khusus owner).
bot.command('resend', async (ctx) => {
    const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ADMIN_IDS.includes(String(ctx.from.id))) return;
    const orderId = ctx.message.text.replace(/^\/resend(@\w+)?\s*/i, '').trim();
    if (!orderId) {
        return ctx.reply('Format: `/resend <ID_ORDER>`\nLihat daftar dengan /belumkirim', { parse_mode: 'Markdown' });
    }
    try {
        const order = await Order.findOne({ orderId }).lean();
        if (!order) return ctx.reply('❌ Order tidak ditemukan.');
        if (order.status !== 'PAID') return ctx.reply(`❌ Status order \`${orderId}\` = ${order.status} (bukan PAID), tidak dikirim.`, { parse_mode: 'Markdown' });
        if (!order.reservedItems || order.reservedItems.length === 0) {
            return ctx.reply('❌ Data akun order ini sudah kosong (kemungkinan sudah lewat masa retensi). Tidak bisa dikirim ulang otomatis.');
        }
        const ok = await deliverAccountsToCustomer(order, (order.paymentGateway || 'QRIS').toUpperCase());
        await ctx.reply(ok ? `✅ Akun order \`${orderId}\` berhasil dikirim ulang ke customer.` : `❌ Masih gagal kirim ke customer untuk \`${orderId}\`. Cek apakah bot diblokir user.`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`);
    }
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

// Rekonsiliasi order Pakasir yang mungkin dibayar saat bot mati (ditunda 20 detik
// agar koneksi DB siap). Menutup celah "sudah bayar tapi bot restart".
setTimeout(reconcilePakasirPendingOrders, 20 * 1000);

// Pengecekan akun DigitalOcean di stok: sekali saat start (ditunda 60 detik
// agar koneksi DB & bot siap), lalu berkala (default tiap 1 jam). Akun yang
// berstatus locked otomatis dihapus dari stok dan dilaporkan ke OWNER_ID.
setTimeout(() => docheck.runDigitalOceanCheck(bot), 60 * 1000);
setInterval(() => docheck.runDigitalOceanCheck(bot), docheck.CHECK_INTERVAL_MS);

// Jaring pengaman: jangan biarkan error tak tertangkap mematikan seluruh bot
// (mis. error di dalam polling/timer). Cukup dicatat + dilaporkan ke owner.
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
    const owners = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    const msg = (reason && reason.message) ? reason.message : String(reason);
    for (const o of owners) {
        bot.telegram.sendMessage(o, `⚠️ [BOT] Unhandled rejection:\n${msg}`).catch(() => {});
    }
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    const owners = (process.env.OWNER_ID || '').split(',').map(id => id.trim()).filter(Boolean);
    for (const o of owners) {
        bot.telegram.sendMessage(o, `⚠️ [BOT] Uncaught exception:\n${err.message}`).catch(() => {});
    }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
