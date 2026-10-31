// qris_autogopay.js — AutoGoPay (autogopay.site), QRIS dinamis merchant GoPay.
// Antarmuka sengaja disamakan dengan qris_pakasir.js (createTransaction / checkPaymentStatus)
// supaya alur pesanan, sweeper, dan pembayaran telat yang sudah ada tetap dipakai apa adanya.
//
// ID transaksi disimpan dengan awalan "agp:" di field pakasirTxnId, jadi semua kode
// (termasuk sinkron Dana Alim di bot FZI) tahu order ini dibayar lewat AutoGoPay.
//
// Catatan API (dicek langsung, berbeda dari dokumentasi):
//   * Stempel waktu /qris/* memakai UTC+8, bukan WIB.
//   * /qris/status membalas success:false untuk SEMUA transaksi yang belum lunas;
//     status asli ada di data.transaction_status. Hanya settlement yang success:true.
// TIDAK ada retry otomatis: generate QRIS berulang dianggap spam dan bisa memblokir merchant.
const axios = require("axios");
const settings = require("./qris_settings");

const BASE = "https://v1-gateway.autogopay.site";
const PREFIX = "agp:";
const QR_LIFETIME_MS = 15 * 60 * 1000;

const isAgpTxn = (txnId) => String(txnId || "").startsWith(PREFIX);

// Key dari env AUTOGOPAY_API_KEY, atau yang disimpan owner lewat /setagpkey.
function apiKey() {
  const key = settings.apiKey();
  if (!key) throw new Error("API key AutoGoPay belum diatur (env AUTOGOPAY_API_KEY atau /setagpkey)");
  return key;
}

async function call(path, body, timeout, key) {
  if (!key) await settings.ensureLoaded();
  const res = await axios.post(BASE + path, body, {
    headers: { Authorization: `Bearer ${key || apiKey()}`, "Content-Type": "application/json" },
    timeout,
    maxRedirects: 0,
    validateStatus: () => true,
  });
  return { http: res.status, data: res.data || {} };
}

// "2026-10-30 18:58:00" tanpa zona: coba +08:00 lalu +07:00, pakai yang masuk akal
// (maks 20 menit ke depan). Tidak cocok -> 15 menit dari sekarang.
function expiryDate(value, now = Date.now()) {
  const str = String(value || "").trim();
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  for (const c of zoned ? [str] : ["+08:00", "+07:00"].map((z) => str.replace(" ", "T") + z)) {
    const t = Date.parse(c);
    if (Number.isFinite(t) && t > now && t <= now + 20 * 60 * 1000) return new Date(t);
  }
  return new Date(now + QR_LIFETIME_MS);
}

/** Sama bentuknya dengan qris_pakasir.createTransaction. */
async function createTransaction(internalOrderId, amount) {
  const n = parseInt(amount, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000000) throw new Error("Nominal QRIS harus 1 – 10.000.000");
  // SATU kali panggil. Jangan diulang otomatis walau timeout: invoice mungkin sudah terbuat.
  const { http, data } = await call("/qris/generate", { amount: n }, 20000);
  const d = data.data;
  if (http !== 200 || data.success !== true || !d || !d.transaction_id || !d.qr_string) {
    throw new Error(`AutoGoPay gagal membuat QRIS (HTTP ${http}): ${data.message || "-"}`);
  }
  if (d.amount != null && Number(d.amount) !== n) throw new Error("AutoGoPay: nominal QRIS tidak cocok");
  return {
    displayOrderId: String(internalOrderId),
    realOrderId: d.order_id ? String(d.order_id) : String(internalOrderId),
    txnId: PREFIX + String(d.transaction_id),
    qrString: d.qr_string,
    qrImage: null,
    amount: n,
    totalBayar: n, // tanpa biaya untuk pembeli
    fee: 0,
    expiredAt: expiryDate(d.expiry_time).toISOString(),
    isSandbox: false,
    status: "pending",
  };
}

const STATUS = {
  settlement: "completed", capture: "completed", paid: "completed", success: "completed",
  pending: "pending", expire: "expired", expired: "expired", cancel: "canceled", cancelled: "canceled", deny: "canceled",
};

/**
 * Sama bentuknya dengan qris_pakasir.checkPaymentStatus: objek { status, amount, order_id, ... }
 * atau null bila gagal dicek (jaringan / API error) — JANGAN dianggap gagal bayar.
 */
async function checkPaymentStatus(txnId) {
  if (!isAgpTxn(txnId)) return null;
  const id = String(txnId).slice(PREFIX.length);
  try {
    const { http, data } = await call("/qris/status", { transaction_id: id }, 12000);
    if (http >= 500 || http === 401 || http === 403 || http === 429) {
      console.error("[AUTOGOPAY CHECK ERROR] HTTP", http, data.message || "");
      return null;
    }
    const d = data.data || {};
    if (d.transaction_id && String(d.transaction_id) !== id) return null; // jawaban untuk transaksi lain
    const raw = String(d.transaction_status || d.status || "").toLowerCase();
    const amt = d.gross_amount != null ? d.gross_amount : d.amount;
    return {
      txn_id: txnId,
      order_id: null, // AutoGoPay memakai order_id sendiri; pencocokan lewat transaction_id
      status: STATUS[raw] || (raw ? "pending" : ""),
      amount: amt == null || amt === "" ? null : Number(amt),
      is_sandbox: false,
      completed_at: null,
    };
  } catch (error) {
    console.error("[AUTOGOPAY CHECK ERROR]", error.message);
    return null;
  }
}

/** Batalkan QRIS supaya tidak bisa dibayar lagi. Gagal tidak fatal (QRIS gugur ±15 menit). */
async function cancelTransaction(txnId) {
  if (!isAgpTxn(txnId)) return false;
  try {
    const { data } = await call("/qris/cancel", { transaction_id: String(txnId).slice(PREFIX.length) }, 12000);
    return data.success === true;
  } catch (error) {
    console.error("[AUTOGOPAY CANCEL ERROR]", error.message);
    return false;
  }
}

/**
 * Cek apakah key valid TANPA membuat QRIS: hanya membaca daftar transaksi (read-only).
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function verifyKey(key) {
  try {
    const { http, data } = await call("/transactions", {}, 15000, key);
    if (http === 200 && data.success === true) return { ok: true };
    if (http === 401 || http === 403) return { ok: false, reason: data.message || "key ditolak AutoGoPay" };
    return { ok: false, reason: `AutoGoPay membalas HTTP ${http}${data.message ? ": " + data.message : ""}` };
  } catch (error) {
    return { ok: false, reason: `tidak bisa menghubungi AutoGoPay (${error.message})` };
  }
}

module.exports = { createTransaction, checkPaymentStatus, cancelTransaction, verifyKey, isAgpTxn, expiryDate, PREFIX };
