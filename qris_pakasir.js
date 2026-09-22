// qris_pakasir.js
// Integrasi Payment Gateway Pakasir API v2 (https://pakasir.com/p/create-transaction)
// Metode pembayaran: QRIS saja.
//
// PENTING (perbedaan v1 -> v2):
//   - Endpoint create : POST /api/v2/create-transaction/{slug}/{order_id}
//   - Endpoint status : GET  /api/v2/transaction-status/{slug}/{txn_id}
//   - API key dikirim lewat header  X-Api-Key  (bukan lagi di body/query)
//   - Body create cukup { method: "qris", amount }
//   - Response berbentuk FLAT (tanpa wrapper "payment"/"transaction")
//   - Transaksi dikenali dengan txn_id (WAJIB disimpan untuk cek status)
//   - Webhook diverifikasi lewat header  X-Secret  (bukan tanda tangan HMAC)
//
// Biaya (fee) DITANGGUNG CUSTOMER: kita kirim `amount` = harga yang ingin
// diterima merchant, dan customer membayar `total_payment` (= amount + fee).
// Pastikan di dashboard Pakasir setelan "Beban Biaya" = Pembeli/Customer.
//
// Kredensial di .env:
//   PAKASIR_PROJECT         -> slug project di dashboard Pakasir (mis. "fzi-store")
//   PAKASIR_API_KEY         -> API key project Pakasir (dikirim sebagai X-Api-Key)
//   PAKASIR_WEBHOOK_SECRET  -> nilai "Secret" di detail project (untuk verifikasi X-Secret)
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const PAKASIR_BASE = "https://app.pakasir.com/api/v2";

function getCreds() {
  const project = process.env.PAKASIR_PROJECT;
  const api_key = process.env.PAKASIR_API_KEY;
  if (!project) throw new Error("PAKASIR_PROJECT (slug project) belum diisi di .env");
  if (!api_key) throw new Error("PAKASIR_API_KEY belum diisi di .env");
  return { project, api_key };
}

/**
 * Membuat transaksi QRIS baru di Pakasir (API v2).
 * @param {string} internalOrderId  ID order internal kita, dipakai sebagai order_id Pakasir.
 * @param {number} amount           Nominal dasar (Rp) yang ingin DITERIMA merchant.
 * @returns {object} { displayOrderId, realOrderId, txnId, qrString, qrImage,
 *                     amount, totalBayar, fee, expiredAt, isSandbox, status }
 */
async function createTransaction(internalOrderId, amount) {
  const { project, api_key } = getCreds();

  const nominalAmount = parseInt(amount);
  if (isNaN(nominalAmount) || nominalAmount <= 0) {
    throw new Error("Amount harus berupa angka positif");
  }

  // slug & order_id kini berada di URL path (bukan di body).
  const url =
    `${PAKASIR_BASE}/create-transaction/` +
    `${encodeURIComponent(project)}/${encodeURIComponent(String(internalOrderId))}`;

  const body = { method: "qris", amount: nominalAmount };

  try {
    const response = await axios({
      method: "post",
      maxBodyLength: Infinity,
      url,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
      },
      data: body,
    });

    // v2: response FLAT langsung di response.data (tanpa wrapper "payment").
    const d = response.data || {};

    // Untuk QRIS, string QRIS ada di 'qr_string'. Sertakan alternatif utk jaga-jaga.
    const qrString =
      d.qr_string || d.qris_data || d.payment_number || d.qris || d.qrString || d.qr;
    if (!qrString) {
      throw new Error("Pakasir tidak mengembalikan QRIS (qr_string).");
    }

    return {
      displayOrderId: String(internalOrderId),
      realOrderId: d.order_id || String(internalOrderId),
      // WAJIB disimpan: dipakai untuk cek status & rekonsiliasi di v2.
      txnId: d.txn_id || null,
      qrString: qrString,
      qrImage: null, // di-generate dari qrString oleh pemanggil (QRCode.toDataURL)
      amount: d.amount != null ? d.amount : nominalAmount,        // nominal dasar (diterima merchant)
      totalBayar: d.total_payment != null ? d.total_payment : (d.amount != null ? d.amount : nominalAmount), // dibayar customer (sudah termasuk fee)
      fee: d.fee != null ? d.fee : 0,
      expiredAt: d.expired_at,
      isSandbox: d.is_sandbox === true,
      status: d.status || "pending",
    };
  } catch (error) {
    if (error.response) {
      console.error("[PAKASIR CREATE ERROR]", {
        status: error.response.status,
        data: error.response.data,
      });
      const raw =
        typeof error.response.data === "object"
          ? JSON.stringify(error.response.data)
          : String(error.response.data);
      throw new Error(`Pakasir API Error (HTTP ${error.response.status}): ${raw}`);
    }
    console.error("[PAKASIR CREATE ERROR]", error.message);
    throw error;
  }
}

/**
 * Cek status transaksi QRIS di Pakasir (API v2).
 * v2 memakai txn_id (bukan lagi order_id + amount).
 * @param {string} txnId  txn_id hasil createTransaction.
 * @returns {object|null} response FLAT: { txn_id, order_id, amount, is_sandbox, status, completed_at } atau null.
 */
async function checkPaymentStatus(txnId) {
  const { project, api_key } = getCreds();
  if (!txnId) {
    console.error("[PAKASIR CHECK ERROR] txnId kosong — tidak bisa cek status (order lama tanpa txn_id?)");
    return null;
  }

  try {
    const response = await axios.get(
      `${PAKASIR_BASE}/transaction-status/${encodeURIComponent(project)}/${encodeURIComponent(String(txnId))}`,
      { headers: { "X-Api-Key": api_key } }
    );
    return response.data; // flat
  } catch (error) {
    if (error.response) {
      console.error("[PAKASIR CHECK ERROR]", {
        status: error.response.status,
        data: error.response.data,
      });
    } else {
      console.error("[PAKASIR CHECK ERROR]", error.message);
    }
    return null;
  }
}

/**
 * Verifikasi header webhook Pakasir v2: X-Secret harus sama dengan PAKASIR_WEBHOOK_SECRET.
 * @param {string} secretHeader  nilai header 'x-secret' dari request.
 * @returns {boolean}
 */
function verifyWebhookSecret(secretHeader) {
  const expected = process.env.PAKASIR_WEBHOOK_SECRET;
  if (!expected) {
    console.warn("[PAKASIR] PAKASIR_WEBHOOK_SECRET belum diisi di .env — verifikasi X-Secret dilewati.");
    return false;
  }
  const got = String(secretHeader || "");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(got, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * (Opsional) Kalkulator biaya publik v2 — tidak butuh API key.
 * GET /api/v2/payment-fee/{amount} -> { qris: 394, bri_va: 3500, ... }
 * @param {number} amount
 * @returns {number|null} fee QRIS untuk nominal tsb, atau null bila gagal.
 */
async function getQrisFee(amount) {
  try {
    const nominal = parseInt(amount);
    if (isNaN(nominal) || nominal <= 0) return null;
    const response = await axios.get(`${PAKASIR_BASE}/payment-fee/${nominal}`);
    const d = response.data || {};
    return d.qris != null ? d.qris : null;
  } catch (error) {
    console.error("[PAKASIR FEE ERROR]", error.response ? error.response.data : error.message);
    return null;
  }
}

/**
 * Pembatalan transaksi: API v2 TIDAK menyediakan endpoint cancel.
 * Transaksi batal otomatis 24 jam atau lewat dashboard. Status order tetap
 * diurus di DB kita, jadi fungsi ini sekadar stub best-effort.
 */
async function cancelTransaction(/* orderId, amount */) {
  console.warn("[PAKASIR] cancelTransaction: tidak tersedia di API v2 (batal otomatis 24 jam / lewat dashboard).");
  return null;
}

/**
 * Simulasi pembayaran: tidak didokumentasikan di API v2 (gunakan Sandbox/dashboard).
 */
async function simulatePayment(/* orderId, amount */) {
  console.warn("[PAKASIR] simulatePayment: tidak tersedia di API v2 (pakai mode Sandbox di dashboard).");
  return null;
}

module.exports = {
  init: async () => console.log("[ Pakasir QRIS Payment System Initialized (API v2) ]"),
  createTransaction,
  checkPaymentStatus,
  verifyWebhookSecret,
  getQrisFee,
  cancelTransaction,
  simulatePayment,
};
