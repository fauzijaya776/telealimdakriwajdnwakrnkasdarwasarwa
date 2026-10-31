// qris_settings.js — konfigurasi AutoGoPay yang bisa diatur owner lewat Telegram (tanpa env hosting).
//
// Urutan sumber:
//   API key : env AUTOGOPAY_API_KEY  ->  key yang disimpan lewat /setagpkey (database)
//   gateway : env PAYMENT_PROVIDER    ->  pilihan /agpgateway (database)  ->  otomatis
//
// Key di database disimpan TERENKRIPSI (AES-256-GCM). Kunci enkripsinya diturunkan dari
// BOT_TOKEN yang sudah ada di env hosting, jadi isi database saja tidak cukup untuk membaca
// key. Kalau BOT_TOKEN diganti, key lama tidak bisa dibuka lagi -> kirim ulang /setagpkey.
const crypto = require("crypto");
const mongoose = require("mongoose");

const REFRESH_MS = 60 * 1000;
let Settings = null;
const cache = { key: null, provider: null, setAt: null, setBy: null, decryptFailed: false, loadedAt: 0 };
let loading = null;

function model() {
  if (!Settings) Settings = require("./db").Settings;
  return Settings;
}
function _setModelForTest(m) { Settings = m; cache.loadedAt = 0; }

function cipherKey() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN kosong: key tidak bisa dienkripsi");
  return crypto.createHash("sha256").update("alim-agp-key|v1|" + token).digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored || "").split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("format key tersimpan tidak dikenal");
  const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

const dbReady = () => mongoose.connection.readyState === 1 || Settings !== null && Settings.__fake === true;

async function load() {
  if (!dbReady()) return; // belum terhubung: coba lagi nanti, jangan menggantung
  const s = await model().findOne({ identifier: "global-settings" },
    { agp_key_enc: 1, agp_key_set_at: 1, agp_key_set_by: 1, payment_provider: 1 }).lean();
  cache.key = null; cache.decryptFailed = false;
  if (s && s.agp_key_enc) {
    try { cache.key = decrypt(s.agp_key_enc); } catch (e) { cache.decryptFailed = true; console.error("[AUTOGOPAY] key tersimpan tidak bisa dibuka (BOT_TOKEN berubah?)"); }
  }
  cache.provider = s && ["autogopay", "pakasir"].includes(s.payment_provider) ? s.payment_provider : null;
  cache.setAt = s ? s.agp_key_set_at || null : null;
  cache.setBy = s ? s.agp_key_set_by || null : null;
  cache.loadedAt = Date.now();
}

/** Pastikan cache segar (dipanggil sebelum membuat / mengecek QRIS). Tidak pernah melempar. */
async function ensureLoaded(force = false) {
  if (!force && cache.loadedAt && Date.now() - cache.loadedAt < REFRESH_MS) return;
  if (!loading) loading = load().catch((e) => console.error("[AUTOGOPAY] gagal membaca pengaturan:", e.message)).finally(() => { loading = null; });
  await loading;
}

const apiKey = () => process.env.AUTOGOPAY_API_KEY || cache.key || null;
const keySource = () => (process.env.AUTOGOPAY_API_KEY ? "env" : cache.key ? "telegram" : null);

/** Gateway untuk order BARU. */
function activeProvider() {
  const env = String(process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  if (env === "autogopay" || env === "pakasir") return env;
  if (cache.provider) return cache.provider;
  return apiKey() ? "autogopay" : "pakasir";
}
const providerSource = () => {
  const env = String(process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  if (env === "autogopay" || env === "pakasir") return "env";
  return cache.provider ? "telegram" : "otomatis";
};

async function saveKey(key, byUserId) {
  await model().updateOne({ identifier: "global-settings" },
    { $set: { agp_key_enc: encrypt(key), agp_key_set_at: new Date(), agp_key_set_by: String(byUserId) } }, { upsert: true });
  await ensureLoaded(true);
}
async function clearKey() {
  await model().updateOne({ identifier: "global-settings" },
    { $unset: { agp_key_enc: "", agp_key_set_at: "", agp_key_set_by: "" } }, { upsert: true });
  await ensureLoaded(true);
}
async function setProvider(p) {
  const update = p === "auto" ? { $unset: { payment_provider: "" } } : { $set: { payment_provider: p } };
  await model().updateOne({ identifier: "global-settings" }, update, { upsert: true });
  await ensureLoaded(true);
}

const mask = (k) => (k && k.length > 12 ? `${k.slice(0, 8)}…${k.slice(-4)}` : "****");
const looksLikeKey = (k) => /^agp_[A-Za-z0-9_-]{16,200}$/.test(String(k || ""));

module.exports = {
  ensureLoaded, apiKey, keySource, activeProvider, providerSource,
  saveKey, clearKey, setProvider, mask, looksLikeKey,
  info: () => ({ setAt: cache.setAt, setBy: cache.setBy, decryptFailed: cache.decryptFailed }),
  _encrypt: encrypt, _decrypt: decrypt, _setModelForTest,
};
