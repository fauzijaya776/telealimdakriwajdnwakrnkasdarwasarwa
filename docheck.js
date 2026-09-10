// =================================================================
// docheck.js — Pengecekan otomatis akun DigitalOcean di stok
//
// Cara kerja:
//   - Setiap variant produk punya array `stock` berisi baris-baris akun.
//   - Untuk tiap item stok, ambil BARIS PERTAMA, lalu ambil teks dari
//     'dop_v1' sampai pembatas '|'. Itulah TOKEN API akun DigitalOcean.
//   - Cek token ke DigitalOcean API (GET /v2/account).
//       * status "active" (atau "warning")  -> akun masih HIDUP  -> biarkan
//       * status "locked"                    -> akun MATI         -> hapus + lapor owner
//   - Item yang tokennya invalid/dicabut (401) hanya DILAPORKAN ke owner
//     untuk dicek manual, TIDAK dihapus otomatis (biar aman dari salah hapus).
//   - Error jaringan/rate-limit dilewati, dicoba lagi di siklus berikutnya.
//
// Referensi API: https://docs.digitalocean.com/reference/api/  (GET /v2/account)
//
// Konfigurasi opsional lewat .env:
//   DO_CHECK_INTERVAL_HOURS  default 1   (interval pengecekan, jam)
//   DO_CHECK_DELAY_MS        default 1500 (jeda antar-request, anti rate-limit)
// =================================================================

require('dotenv').config();
const axios = require('axios');
const { Product } = require('./db');

const DO_API_URL = 'https://api.digitalocean.com/v2/account';
const TOKEN_PREFIX = 'dop_v1';

const CHECK_INTERVAL_HOURS = parseFloat(process.env.DO_CHECK_INTERVAL_HOURS || '1');
const CHECK_INTERVAL_MS = Math.max(CHECK_INTERVAL_HOURS, 0.05) * 60 * 60 * 1000;
const REQUEST_DELAY_MS = parseInt(process.env.DO_CHECK_DELAY_MS || '1500', 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------
// Ambil token API dari sebuah item stok.
// Aturan: BARIS PERTAMA, ambil dari 'dop_v1' sampai pembatas '|'.
// Return null jika item bukan akun DigitalOcean.
// -----------------------------------------------------------------
function extractToken(stockItem) {
    if (!stockItem || typeof stockItem !== 'string') return null;
    const firstLine = stockItem.split(/\r?\n/)[0].trim();
    const idx = firstLine.indexOf(TOKEN_PREFIX);
    if (idx === -1) return null;
    let token = firstLine.slice(idx);
    const pipe = token.indexOf('|');
    if (pipe !== -1) token = token.slice(0, pipe);
    return token.trim() || null;
}

// Sembunyikan sebagian token untuk ditampilkan di pesan.
function maskToken(token) {
    if (!token) return '(kosong)';
    if (token.length <= 14) return token;
    return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

// -----------------------------------------------------------------
// Cek satu akun ke DigitalOcean API.
// Return: 'active' | 'locked' | 'invalid' | 'error'
// -----------------------------------------------------------------
async function checkAccount(token) {
    try {
        const res = await axios.get(DO_API_URL, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20000,
            validateStatus: () => true, // status ditangani manual
        });

        if (res.status === 200 && res.data && res.data.account) {
            const status = String(res.data.account.status || '').toLowerCase();
            if (status === 'active' || status === 'warning') return 'active';
            if (status === 'locked') return 'locked';
            return status || 'error';
        }

        // 401/403: token dicabut atau akun dinonaktifkan/terkunci.
        if (res.status === 401 || res.status === 403) {
            const body = JSON.stringify(res.data || '').toLowerCase();
            if (body.includes('lock')) return 'locked';
            return 'invalid';
        }

        // 429 (rate limit) / 5xx: anggap error sementara.
        return 'error';
    } catch (err) {
        return 'error';
    }
}

// -----------------------------------------------------------------
// Kirim pesan ke semua OWNER_ID (bisa dipisah koma di .env).
// -----------------------------------------------------------------
async function notifyOwners(bot, text) {
    const owners = (process.env.OWNER_ID || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    if (owners.length === 0) {
        console.warn('[DO-CHECK] OWNER_ID belum diatur, notifikasi dilewati.');
        return;
    }
    for (const ownerId of owners) {
        try {
            await bot.telegram.sendMessage(ownerId, text, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(`[DO-CHECK] Gagal kirim ke owner ${ownerId}:`, err.message);
        }
    }
}

async function sendOwnersDocument(bot, buffer, filename, caption) {
    const owners = (process.env.OWNER_ID || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    for (const ownerId of owners) {
        try {
            await bot.telegram.sendDocument(
                ownerId,
                { source: buffer, filename },
                { caption }
            );
        } catch (err) {
            console.error(`[DO-CHECK] Gagal kirim dokumen ke owner ${ownerId}:`, err.message);
        }
    }
}

// -----------------------------------------------------------------
// Proses utama: scan semua stok, cek akun DO, hapus yang locked.
// Dipanggil sekali saat start lalu berkala oleh setInterval di all.js.
// Dijaga agar tidak jalan dobel (guard `running`).
// -----------------------------------------------------------------
let running = false;

async function runDigitalOceanCheck(bot) {
    if (running) {
        console.log('[DO-CHECK] Siklus sebelumnya masih berjalan, dilewati.');
        return { skipped: true };
    }
    running = true;

    const removed = [];   // akun locked yang dihapus
    const invalid = [];   // token invalid (lapor manual)
    let checked = 0;

    try {
        const products = await Product.find().lean();

        for (const product of products) {
            for (const variant of product.variants || []) {
                const stock = variant.stock || [];
                for (const item of stock) {
                    const token = extractToken(item);
                    if (!token) continue; // bukan akun DigitalOcean

                    checked += 1;
                    const status = await checkAccount(token);
                    await sleep(REQUEST_DELAY_MS); // anti rate-limit

                    if (status === 'locked') {
                        // Hapus item ini dari stok (pakai _id variant biar akurat).
                        try {
                            await Product.updateOne(
                                { id: product.id, 'variants._id': variant._id },
                                { $pull: { 'variants.$.stock': item } }
                            );
                            removed.push({
                                product: product.name,
                                variant: variant.name,
                                token,
                                item,
                            });
                            console.log(`[DO-CHECK] LOCKED dihapus: ${maskToken(token)} (${product.name} - ${variant.name})`);
                        } catch (delErr) {
                            console.error(`[DO-CHECK] Gagal hapus stok locked ${maskToken(token)}:`, delErr.message);
                        }
                    } else if (status === 'invalid') {
                        invalid.push({
                            product: product.name,
                            variant: variant.name,
                            token,
                        });
                    }
                    // 'active' -> biarkan; 'error' -> coba lagi siklus berikutnya
                }
            }
        }

        // ---- Laporan ke owner ----
        if (removed.length > 0) {
            const lines = [
                '🔒 *Akun DigitalOcean Terkunci Terdeteksi*',
                '',
                `Ditemukan *${removed.length}* akun berstatus *LOCKED* (mati) dan sudah *dihapus dari stok*:`,
                '',
            ];
            removed.forEach((r, i) => {
                lines.push(`${i + 1}. ${r.product} — ${r.variant}\n   \`${maskToken(r.token)}\``);
            });
            await notifyOwners(bot, lines.join('\n'));

            // Lampirkan detail lengkap akun yang dihapus (buat arsip owner).
            const fileContent = removed
                .map((r) => `# ${r.product} - ${r.variant}\n${r.item}`)
                .join('\n\n');
            await sendOwnersDocument(
                bot,
                Buffer.from(fileContent, 'utf-8'),
                `do_locked_${Date.now()}.txt`,
                `Detail ${removed.length} akun DigitalOcean locked yang dihapus dari stok.`
            );
        }

        if (invalid.length > 0) {
            const lines = [
                '⚠️ *Token DigitalOcean Invalid*',
                '',
                `Ada *${invalid.length}* akun yang tokennya *invalid/ditolak* (401). Tidak dihapus otomatis — silakan cek manual:`,
                '',
            ];
            invalid.forEach((r, i) => {
                lines.push(`${i + 1}. ${r.product} — ${r.variant}\n   \`${maskToken(r.token)}\``);
            });
            await notifyOwners(bot, lines.join('\n'));
        }

        console.log(`[DO-CHECK] Selesai. Dicek: ${checked}, locked-dihapus: ${removed.length}, invalid: ${invalid.length}.`);
        return { checked, removed: removed.length, invalid: invalid.length };
    } catch (error) {
        console.error('[DO-CHECK] Error:', error.message);
        return { error: error.message };
    } finally {
        running = false;
    }
}

module.exports = {
    runDigitalOceanCheck,
    checkAccount,
    extractToken,
    CHECK_INTERVAL_MS,
    CHECK_INTERVAL_HOURS,
};
