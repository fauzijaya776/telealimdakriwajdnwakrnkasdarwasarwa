// qris_gateway.js — pemilih gateway QRIS (AutoGoPay / Pakasir) + aturan anti-blokir.
//
// Gateway untuk order BARU: PAYMENT_PROVIDER=autogopay | pakasir, atau diatur owner lewat
// Telegram (/setagpkey, /agpgateway) bila env hosting tidak bisa diubah. Lihat qris_settings.js.
// Order lama selalu dicek ke gateway pembuatnya: ID AutoGoPay berawalan "agp:".
const pakasir = require("./qris_pakasir");
const autogopay = require("./qris_autogopay");
const settings = require("./qris_settings");

// Gateway order baru: env PAYMENT_PROVIDER -> /agpgateway (database) -> otomatis
// (autogopay kalau ada API key dari env atau /setagpkey, selain itu pakasir).
const active = () => settings.activeProvider();

async function createTransaction(orderId, amount) {
  await settings.ensureLoaded();
  return (active() === "autogopay" ? autogopay : pakasir).createTransaction(orderId, amount);
}

const checkPaymentStatus = (txnId) =>
  (autogopay.isAgpTxn(txnId) ? autogopay : pakasir).checkPaymentStatus(txnId);

const cancelTransaction = (txnId) => (autogopay.isAgpTxn(txnId) ? autogopay.cancelTransaction(txnId) : Promise.resolve(false));

// ---------------- aturan anti-blokir ----------------
// Provider menganggap generate QRIS berulang sebagai spam; yang diblokir akun merchant KITA.
const envInt = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const LIMITS = {
  maxPerDay: () => envInt("QRIS_MAX_PER_DAY", 8),        // QRIS per pembeli per 24 jam
  maxUnpaid: () => envInt("QRIS_MAX_UNPAID", 5),         // tak dibayar berturut-turut -> dikunci (maks 24 jam)
  gapMin: () => envInt("QRIS_COOLDOWN_MIN", 3),          // jeda antar QRIS (kecuali yang terakhir lunas)
  globalPerMin: () => envInt("QRIS_GLOBAL_PER_MIN", 30), // rem darurat seluruh bot
};
const enabled = () => process.env.PAYMENT_ENABLED !== "0";

/**
 * Dicek SEBELUM stok ditahan & QRIS dibuat.
 * @returns {Promise<{error?:string, live?:object, brake?:boolean}>}  live = order yang QRIS-nya masih berlaku
 */
async function guardNewQris(Order, telegramUserId) {
  if (!enabled()) return { error: "Pembayaran sedang ditutup sementara. Coba lagi nanti, ya." };
  const now = Date.now();
  const mine = await Order.find({
    "customerInfo.telegramUserId": String(telegramUserId),
    paymentGateway: "pakasir",
    createdAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
  }, { orderId: 1, status: 1, createdAt: 1, pakasirTxnId: 1, qrMsgId: 1 }).sort({ createdAt: -1 }).limit(50).lean();

  // 1) Satu pesanan, satu QRIS: yang masih berlaku harus dibayar/dibatalkan dulu.
  const live = mine.find((o) => o.status === "PENDING" && now - new Date(o.createdAt).getTime() < 15 * 60 * 1000);
  if (live) return { live };

  // 2) Tak dibayar berturut-turut.
  let streak = 0;
  for (const o of mine) { if (o.status === "PAID") break; streak += 1; }
  if (LIMITS.maxUnpaid() && streak >= LIMITS.maxUnpaid()) {
    return { error: "Terlalu banyak tagihan yang tidak dibayar. Pembelian QRIS dikunci sementara (maks. 24 jam) — hubungi admin bila perlu." };
  }
  // 3) Batas harian.
  if (LIMITS.maxPerDay() && mine.length >= LIMITS.maxPerDay()) {
    return { error: `Batas ${LIMITS.maxPerDay()} tagihan QRIS per hari tercapai. Coba lagi besok, ya.` };
  }
  // 4) Jeda antar QRIS.
  const last = mine[0];
  if (last && last.status !== "PAID" && LIMITS.gapMin()) {
    const wait = new Date(last.createdAt).getTime() + LIMITS.gapMin() * 60 * 1000 - now;
    if (wait > 0) return { error: `Tunggu ${Math.ceil(wait / 60000)} menit sebelum membuat tagihan baru, ya.` };
  }
  // 5) Rem darurat global.
  if (LIMITS.globalPerMin()) {
    const n = await Order.countDocuments({ paymentGateway: "pakasir", createdAt: { $gte: new Date(now - 60 * 1000) } });
    if (n >= LIMITS.globalPerMin()) return { error: "Sistem pembayaran sedang ramai. Coba lagi 1 menit lagi, ya.", brake: true };
  }
  return {};
}

module.exports = { active, createTransaction, checkPaymentStatus, cancelTransaction, guardNewQris, LIMITS, isAgpTxn: autogopay.isAgpTxn };
