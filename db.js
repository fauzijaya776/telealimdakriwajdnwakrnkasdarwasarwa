const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

// Skema untuk Variant dalam Produk
const VariantSchema = new mongoose.Schema({
    name: String,
    slug: { type: String },
    price: Number,
    stock: [String],
    reserved_stock: [String],
    snk: { type: String, default: '-' },
    bulk_pricing: {
        min_quantity: Number,
        price_per_item: Number,
    }
});

// Skema untuk Produk
const ProductSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    name: String,
    description: String,
    variants: [VariantSchema]
});

// Skema untuk Pengguna
const UserSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    username: String,
    balance: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 }
});

// Skema untuk Pesanan
const OrderSchema = new mongoose.Schema({
    orderId: { type: String, unique: true, required: true },
    // Dipakai TTL index di bawah: order yang TIDAK jadi dibayar otomatis
    // dihapus MongoDB setelah tanggal ini. Order PAID -> field ini di-unset,
    // sehingga tidak pernah kedaluwarsa (dokumen tanpa field ini diabaikan TTL).
    expiresAt: { type: Date },
    internalRefId: String,
    depositId: String,
    amount: Number,
    status: { type: String, enum: ['PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED'], default: 'PENDING' },
    // Penanda apakah akun sudah BENAR-BENAR terkirim ke customer.
    // status PAID = uang masuk; delivered = akun sampai ke pembeli.
    delivered: { type: Boolean, default: false },
    deliveredAt: Date,
    createdAt: { type: Date, default: Date.now },
    paidAt: Date,
    cancelledAt: Date,
    productId: String,
    variantSlug: String,
    productName: String,
    variantName: String,
    quantity: Number,
    reservedItems: [String],
    customerInfo: {
        telegramUserId: String,
        first_name: String,
    },
    paymentGateway: String,
    paymentDetails: Object
});

const SettingsSchema = new mongoose.Schema({
    // Dibuat unik agar hanya ada satu dokumen pengaturan
    identifier: { type: String, default: 'global-settings', unique: true }, 
    linkqu_enabled: { type: Boolean, default: true },
    dana_enabled: { type: Boolean, default: true },
    tokopay_enabled: { type: Boolean, default: true },
});

// =============================================================
// INDEX & HEMAT STORAGE (MongoDB Atlas M0 = 512MB)
// Kuota M0 dihitung dari dataSize + indexSize, jadi menghapus dokumen
// benar-benar menurunkan pemakaian kuota.
// =============================================================

// TTL index: MongoDB menghapus dokumen otomatis saat `expiresAt` terlewat.
// expireAfterSeconds: 0 = kedaluwarsa tepat pada jam yang tersimpan di field.
// Dokumen yang TIDAK punya field `expiresAt` (semua order PAID) tidak pernah
// disentuh TTL monitor.
OrderSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' });

// Dipakai fitur 'Riwayat Transaksi' (sebelumnya collection scan tiap ditekan).
OrderSchema.index({ 'customerInfo.telegramUserId': 1, status: 1 });

const Settings = mongoose.model('Settings', SettingsSchema);
const Product = mongoose.model('Product', ProductSchema);
const User = mongoose.model('User', UserSchema);
const Order = mongoose.model('Order', OrderSchema);

// Buang payload mentah gateway (bisa berisi QR base64 / objek besar) dan
// simpan hanya field scalar yang berguna untuk audit. Ini penghemat terbesar
// pada dokumen Order.
function slimPaymentDetails(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const KEEP = [
        'status', 'status_trx', 'rc', 'response_code',
        'reference', 'reff_id', 'partnerreff', 'trx_id', 'transaction_id',
        'order_id', 'merchant_ref', 'amount', 'total_bayar', 'nominal',
        'payment_channel', 'channel', 'paid_at', 'payment_time',
        'settlement_time', 'fee'
    ];
    const slim = {};
    for (const key of KEEP) {
        const value = raw[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'object') continue; // buang objek/array besar
        slim[key] = (typeof value === 'string' && value.length > 120)
            ? value.slice(0, 120)
            : value;
    }
    return Object.keys(slim).length > 0 ? slim : undefined;
}

module.exports = {
    connectDB,
    Product,
    User,
    Order,
    Settings,
    slimPaymentDetails
};