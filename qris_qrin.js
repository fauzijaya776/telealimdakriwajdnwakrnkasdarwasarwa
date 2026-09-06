// qris_qrin.js
// Integrasi Payment Gateway QRIN (https://qrin.web.id) - metode QRIS.
//
// PENTING: QRIN TIDAK menyediakan endpoint cek status (polling). Konfirmasi
// pembayaran HANYA lewat CALLBACK/WEBHOOK: QRIN mengirim POST ke URL callback
// merchant (didaftarkan di Setting Merchant QRIN) setiap kali status berubah.
// Karena itu bot menyediakan route webhook (lihat all.js: POST /qrin/callback)
// dan modul ini menyediakan verifikasi tanda tangannya.
//
// Kredensial di .env:
//   QRIN_TOKEN = token_qrin dari Setting Merchant QRIN
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const QRIN_BASE = "https://qrin.web.id/api";

function getToken() {
  const token = process.env.QRIN_TOKEN;
  if (!token) throw new Error("QRIN_TOKEN belum diisi di .env");
  return token;
}

/**
 * Membuat transaksi QRIS baru di QRIN.
 * @param {string} internalOrderId  no_ref_merchant (referensi unik kita).
 * @param {number} amount           Nominal IDR (min 1.000 untuk QRIS).
 * @param {string} productName      Nama produk untuk product_details.
 * @param {string|number} validityMinutes  Durasi kedaluwarsa (menit), default "5".
 * @returns {object} { displayOrderId, realOrderId, qrString, amount, amountReceived, fee, totalBayar, status, validity }
 */
async function createTransaction(internalOrderId, amount, productName, validityMinutes = "5") {
  const token = getToken();

  const nominal = parseInt(amount);
  if (isNaN(nominal) || nominal < 1000) {
    throw new Error("Nominal QRIS minimal Rp 1.000");
  }

  const body = {
    token_qrin: token,
    payment_method: "qris",
    request_payload: {
      no_ref_merchant: String(internalOrderId),
      amount_value: nominal,
      amount_currency: "IDR",
      // product_details WAJIB berupa STRING berisi JSON array item.
      product_details: JSON.stringify([
        { name: String(productName || "Produk").slice(0, 100), price: nominal },
      ]),
      validity: String(validityMinutes),
    },
  };

  try {
    const response = await axios({
      method: "post",
      maxBodyLength: Infinity,
      url: `${QRIN_BASE}/create-transaksi`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });

    const d = response.data;
    if (!d || d.success !== true || !d.data) {
      throw new Error(`QRIN API Error: ${d && d.message ? d.message : "respons tidak sukses"}`);
    }

    const data = d.data;
    const qrString = data.qris_data;
    if (!qrString) {
      throw new Error("QRIN tidak mengembalikan qris_data (string QRIS).");
    }

    return {
      displayOrderId: String(internalOrderId),
      // QRIN memakai no_ref_merchant sebagai referensi -> sama dengan internalOrderId.
      realOrderId: String(data.no_ref_merchant || internalOrderId),
      qrString: qrString,
      amount: data.amount_value != null ? data.amount_value : nominal, // dibayar customer
      amountReceived: data.amount_received != null ? data.amount_received : nominal, // diterima merchant
      fee: data.merchant_cost != null ? data.merchant_cost : 0,
      totalBayar: data.amount_value != null ? data.amount_value : nominal, // customer_cost QRIS = 0
      status: data.transaction_status || "pending",
      validity: data.validity,
    };
  } catch (error) {
    if (error.response) {
      console.error("[QRIN CREATE ERROR]", {
        status: error.response.status,
        data: error.response.data,
      });
      const raw =
        typeof error.response.data === "object"
          ? JSON.stringify(error.response.data)
          : String(error.response.data);
      throw new Error(`QRIN API Error (HTTP ${error.response.status}): ${raw}`);
    }
    console.error("[QRIN CREATE ERROR]", error.message);
    throw error;
  }
}

/**
 * Verifikasi tanda tangan callback QRIN.
 * X-Callback-Signature = HMAC-SHA256(raw body JSON, token_qrin).
 * @param {string|Buffer} rawBody   Body mentah request callback (persis apa adanya).
 * @param {string} signatureHeader  Nilai header X-Callback-Signature.
 * @returns {boolean}
 */
function verifyCallbackSignature(rawBody, signatureHeader) {
  const token = getToken();
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = crypto.createHmac("sha256", token).update(payload).digest("hex");
  const got = String(signatureHeader || "");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(got, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = {
  init: async () => console.log("[ QRIN QRIS Payment System Initialized (webhook mode) ]"),
  createTransaction,
  verifyCallbackSignature,
};
