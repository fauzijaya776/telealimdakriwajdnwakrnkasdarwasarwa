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
const linkqu = require('./qris_linkqu');
const adminModule = require('./admin');
const QRCode = require('qrcode');
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
        const fileContent = order.reservedItems.join('\n');
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
// verify: simpan body mentah untuk validasi tanda tangan webhook QRIN.
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

    return { message, keyboard: Markup.keyboard(keyboardLayout).resize() };
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
                  `_Silakan atur jumlah pembelian menggunakan tombol +/- di bawah._`;
    
    // Pola callback BARU menggunakan ':' sebagai pemisah: qtymod:{productId}:{variantSlug}:{change}:{qty}:{page}
    const qtyButtons = [
        Markup.button.callback(`➖`, `qty_mod:${productId}:${variantSlug}:-1:${quantity}:${page}`), // <-- DIUBAH
        Markup.button.callback(`${quantity}`, 'ignore_me'),
    ];

    if (quantity < maxStock) {
        qtyButtons.push(Markup.button.callback(`➕`, `qty_mod:${productId}:${variantSlug}:1:${quantity}:${page}`)); // <-- DIUBAH
    }

    const keyboard = [
        qtyButtons,
        [Markup.button.callback('Lanjutkan ke Pembayaran ➡️', `proceed_payment:${productId}:${variantSlug}:${quantity}:${page}`)], // <-- DIUBAH
        [Markup.button.callback('🔄 Kembali', `back_to_details_${productId}_page_${page}`)]
    ];

    if (maxStock >= 5) { 
        const shortcutRow = [];
        if (quantity > 5) {
            shortcutRow.push(Markup.button.callback(`-5`, `qty_mod:${productId}:${variantSlug}:-5:${quantity}:${page}`)); // <-- DIUBAH
        }
        if (quantity + 5 <= maxStock) {
            shortcutRow.push(Markup.button.callback(`+5`, `qty_mod:${productId}:${variantSlug}:5:${quantity}:${page}`)); // <-- DIUBAH
        }

        if (shortcutRow.length > 0) {
            keyboard.splice(1, 0, shortcutRow);
        }
    }

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
        const { message, keyboard } = await generateStartMessageAndKeyboard(ctx);
        const imagePath = path.join(__dirname, 'assets', 'welcome.png');
        // FIX BUG: kalau assets/welcome.png hilang, replyWithPhoto melempar
        // error dan customer hanya melihat "Terjadi kesalahan saat memulai bot".
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);

        if (fileExists) {
            // Keyboard menu utama dilampirkan langsung ke pesan foto
            await ctx.replyWithPhoto(
                { source: imagePath },
                {
                    caption: message,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }

    } catch (error) {
        console.error('Error in /start:', error);
        // Fallback terakhir: kirim tanpa Markdown supaya user tetap dapat menu.
        try {
            const { message, keyboard } = await generateStartMessageAndKeyboard(ctx);
            const plain = message
                .replace(/\\([_*`\[\]])/g, '$1')  // buang backslash hasil escapeMd
                .replace(/[*`]/g, '');
            await ctx.reply(plain, { reply_markup: keyboard.reply_markup });
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

                    const product = await Product.findOne({ id: order.productId });
                    const variant = product ? product.variants.find(v => v.slug === order.variantSlug) : null;
                    const snk = variant && variant.snk ? variant.snk : null;

                    const formattedItems = order.reservedItems.map((item, index) => `${index + 1}. ${item}`).join('\n');
                    
                    // --- LOGIKA KONDISIONAL BARU ---
                    if (order.quantity < 10) {
                        // Jika pembelian < 10, kirim seperti biasa
                        const formattedItems = order.reservedItems.map((item, index) => `${index + 1}. ${item}`).join('\n');
                        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n` + `*Info Pembelian:*\n– Total: Rp ${order.amount.toLocaleString('id-ID')}\n– Metode: DANA\n\n` + "```\n" + `${order.productName.toUpperCase()}\n${formattedItems}` + "\n```";
                        
                        if (snk && snk.trim() !== "" && snk.trim() !== "-") {
                            successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
                        }
                        await bot.telegram.sendMessage(ctx.from.id, successMessage, { parse_mode: 'Markdown' });

                    } else {
                        // Jika pembelian >= 10, kirim via file .txt
                        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n` + `*Info Pembelian:*\n– Total: Rp ${order.amount.toLocaleString('id-ID')}\n– Metode: DANA\n\n` + `Anda membeli *${order.quantity}* item. Akun Anda dikirimkan dalam file terpisah.`;

                        if (snk && snk.trim() !== "" && snk.trim() !== "-") {
                            successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
                        }
                        await bot.telegram.sendMessage(ctx.from.id, successMessage, { parse_mode: 'Markdown' });

                        // Kirim file .txt
                        const fileContent = order.reservedItems.join('\n');
                        const fileName = `akun_${order.orderId}.txt`;
                        await bot.telegram.sendDocument(
                            ctx.from.id,
                            { source: Buffer.from(fileContent, 'utf-8'), filename: fileName },
                            { caption: `Akun untuk order ${order.orderId}` }
                        );
                    }

                    // Notifikasi ke grup admin tidak berubah
                    if (GROUP_NOTIF_ID) {
                        await sendAdminNotification(bot, order);
                    }
                }
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
                    
                    // [TAMBAHAN] Ambil data SNK dari Produk
                    const product = await Product.findOne({ id: order.productId });
                    const variant = product ? product.variants.find(v => v.slug === order.variantSlug) : null;
                    const snk = variant && variant.snk ? variant.snk : null;

                    const formattedItems = order.reservedItems.map((item, index) => `${index + 1}. ${item}`).join('\n');
                    
                    // --- LOGIKA KONDISIONAL BARU ---
                    if (order.quantity < 10) {
                        const formattedItems = order.reservedItems.map((item, index) => `${index + 1}. ${item}`).join('\n');
                        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n` + `*Info Pembelian:*\n– Total Dibayar: Rp ${order.amount.toLocaleString('id-ID')}\n` + `– Metode: QRIS\n– ID Transaksi: \`${payment.realOrderId}\`\n\n` + "```\n" + `${order.productName.toUpperCase()}\n${formattedItems}` + "\n```";

                        if (snk && snk.trim() !== "" && snk.trim() !== "-") {
                            successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
                        }
                        await bot.telegram.sendMessage(order.customerInfo.telegramUserId, successMessage, { parse_mode: 'Markdown' });

                    } else {
                        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!\n\n` + `*Info Pembelian:*\n– Total Dibayar: Rp ${order.amount.toLocaleString('id-ID')}\n` + `– Metode: QRIS\n– ID Transaksi: \`${payment.realOrderId}\`\n\n` + `Anda membeli *${order.quantity}* item. Akun Anda dikirimkan dalam file terpisah.`;

                        if (snk && snk.trim() !== "" && snk.trim() !== "-") {
                            successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
                        }
                        await bot.telegram.sendMessage(order.customerInfo.telegramUserId, successMessage, { parse_mode: 'Markdown' });

                        const fileContent = order.reservedItems.join('\n');
                        const fileName = `akun_${order.orderId}.txt`;
                        await bot.telegram.sendDocument(
                            order.customerInfo.telegramUserId,
                            { source: Buffer.from(fileContent, 'utf-8'), filename: fileName },
                            { caption: `Akun untuk order ${order.orderId}` }
                        );
                    }

                    if (GROUP_NOTIF_ID) {
                        await sendAdminNotification(bot, order);
                    }

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
        // Konfirmasi pembayaran datang dari QRIN via POST /callback -> fulfillQrinPaidOrder().
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

    } finally {
        session.endSession();
    }
});

// ===== Pemenuhan order yang sudah dibayar (dipanggil oleh webhook QRIN) =====
async function fulfillQrinPaidOrder(orderId) {
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

    const product = await Product.findOne({ id: order.productId });
    const variant = product ? product.variants.find(v => v.slug === order.variantSlug) : null;
    const snk = variant?.snk || null;

    if (order.quantity < 10) {
        const formattedItems = order.reservedItems.map((item, index) => `${index + 1}. ${item}`).join('\n');
        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!, Jika Ada Pertanyaan Silahkan Chat Admin Di wa.me/6285753323094\n\n` +
            `*Informasi Pembelian:*\n– Total Dibayar: Rp ${order.amount.toLocaleString('id-ID')}\n` +
            `– Metode: QRIS\n– ID Transaksi: \`${order.orderId}\`\n\n` +
            "```\n" + `${order.productName.toUpperCase()}\n${formattedItems}` + "\n```";
        if (snk && snk.trim() !== "" && snk.trim() !== "-") successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
        await bot.telegram.sendMessage(order.customerInfo.telegramUserId, successMessage, { parse_mode: 'Markdown' }).catch(() => {});
    } else {
        let successMessage = `🧾 *Pembelian Berhasil*\n\nTerima kasih!, Jika Ada Pertanyaan Silahkan Chat Admin Di wa.me/6285753323094\n\n` +
            `*Informasi Pembelian:*\n– Total Dibayar: Rp ${order.amount.toLocaleString('id-ID')}\n` +
            `– Metode: QRIS\n– ID Transaksi: \`${order.orderId}\`\n\n` +
            `Anda membeli *${order.quantity}* item. Akun Anda dikirimkan dalam file terpisah.`;
        if (snk && snk.trim() !== "" && snk.trim() !== "-") successMessage += `\n\n*Syarat & Ketentuan (SNK):*\n${snk}`;
        await bot.telegram.sendMessage(order.customerInfo.telegramUserId, successMessage, { parse_mode: 'Markdown' }).catch(() => {});

        const fileContent = order.reservedItems.join('\n');
        const fileName = `akun_${order.orderId}.txt`;
        await bot.telegram.sendDocument(
            order.customerInfo.telegramUserId,
            { source: Buffer.from(fileContent, 'utf-8'), filename: fileName },
            { caption: `Akun untuk order ${order.orderId}` }
        ).catch(() => {});
    }

    if (GROUP_NOTIF_ID) await sendAdminNotification(bot, order).catch(() => {});
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
                const ownerId = process.env.OWNER_ID;
                if (ownerId) {
                    await bot.telegram.sendMessage(ownerId, `⚠️ [QRIN] Pembayaran diterima untuk order \`${orderId}\` tetapi status order bukan PENDING. Perlu cek manual.`, { parse_mode: 'Markdown' }).catch(() => {});
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
        if (userState.state === 'awaiting_stock') {
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
    console.error(`Error for user ${ctx.from?.id}:`, err);
    try {
        ctx.reply('❌ Maaf, terjadi kesalahan internal. Silakan coba lagi nanti.');
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
