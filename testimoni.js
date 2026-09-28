// testimoni.js
// Posting otomatis STRUK / TESTIMONI ke channel Telegram setiap ada order yang lunas
// dan akunnya sudah terkirim ke pembeli.
//
// - Gambar struk dibuat dengan @napi-rs/canvas  (pasang: npm install @napi-rs/canvas)
// - Bila modul itu belum terpasang atau render gagal, testimoni TETAP diposting
//   sebagai teks saja — bot tidak pernah crash karena fitur ini.
// - ID pembeli disamarkan & nomor transaksi dipendekkan (ID order asli memuat
//   ID Telegram pembeli), data akun yang dibeli TIDAK pernah ikut diposting.
//
// Syarat: bot harus menjadi ADMIN channel dengan izin "Post Messages".
// Matikan fitur dengan env TESTI_CHANNEL=off
'use strict';

const path = require('path');
const fs = require('fs');

// Nama family ASLI dari file TTF (Regular & Bold). Didaftarkan TANPA alias supaya
// pemilihan tebal/tipis (bold) dilakukan oleh Skia dari metadata font itu sendiri.
const FONT_FAMILY = 'Liberation Sans';
const FONT = `"${FONT_FAMILY}"`;
// Tombol di bawah setiap testimoni untuk SUBSCRIBER. Bot tidak bisa mematikan notifikasi
// channel untuk orang tertentu (batasan Telegram), jadi tombol menampilkan cara mematikannya.
const MUTE_CALLBACK = 'testi_mute_info';
const MUTE_BUTTON_TEXT = '🔕 Matikan notifikasi';
// Batas popup Telegram: 200 karakter (dihitung UTF-16) — teks ini 193, jangan diperpanjang.
const MUTE_HOWTO = '🔕 Cara mematikan notifikasi channel ini:\n\n' +
    'Ketuk "Senyapkan" / "Mute" di bagian paling bawah channel.\n\n' +
    'Atau: ketuk nama channel → Notifikasi → Matikan.\n\n' +
    'Testimoni tetap bisa dilihat kapan saja.';

// Antrean testimoni (tercatat di dokumen Order, tahan restart):
const SEND_TRIES = 4;                  // percobaan kirim per sekali proses
const BACKOFF_MS = [3000, 10000, 20000]; // jeda antar percobaan (error jaringan / server)
const LOCK_MS = 10 * 60 * 1000;        // kunci anti-dobel (lebih lama dari waktu kirim terlama ±4 menit)
const MAX_ATTEMPTS = 6;                // batas total percobaan (termasuk sapuan ulang)
const SWEEP_EVERY_MS = 10 * 60 * 1000; // sapu ulang testimoni yang belum terposting
const SWEEP_WINDOW_H = 48;             // hanya order yang antre dalam 48 jam terakhir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 1000;          // lebar logis gambar
const SCALE = 1.5;       // hasil PNG = 1500 px
const PAD = 36;          // jarak kartu ke tepi gambar
const CX = PAD;
const CW = W - PAD * 2;  // lebar kartu
const X0 = CX + 40;      // tepi kiri konten
const X1 = CX + CW - 40; // tepi kanan konten
const CONTENT_W = X1 - X0;

// ------------------------------------------------------------------ format
function rp(n) {
    const v = Math.round(Number(n) || 0);
    return 'Rp ' + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ID Telegram umumnya 9-10 digit. Tampilkan 3 depan + 2 belakang saja, jumlah
// bintang tetap (****) supaya panjang ID pun tidak ketahuan.
function maskId(id) {
    const s = String(id == null ? '' : id).trim();
    if (!s) return '-';
    if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-2);
    if (s.length >= 4) return s.slice(0, 2) + '****' + s.slice(-1);
    return s[0] + '****';
}

// Font struk tidak punya glyph emoji/bendera -> di gambar akan jadi kotak kosong.
// Buang emoji HANYA untuk teks di GAMBAR (caption Telegram tetap utuh dengan emoji).
// ©, ® dan ™ dipertahankan karena tersedia di font.
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[‍︎️⃣]/gu;
function cleanForImage(text, fallback) {
    const t = String(text == null ? '' : text).replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
    return t || fallback || '';
}

function shortTrx(orderId, prefix) {
    // "P-1641090169-1790000058421" -> "58421" (ID pembeli di tengah tidak ikut)
    const last = String(orderId || '').split('-').pop().replace(/\D/g, '');
    return (last || String(Date.now())).slice(-5);
}

function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(when) {
    const d = when ? new Date(when) : new Date();
    try {
        const moment = require('moment-timezone');
        return moment(d).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm') + ' WIB';
    } catch (e) {
        const p = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
        return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} WIB`;
    }
}

// Ubah dokumen Order menjadi data struk (tanpa data akun apa pun).
function buildReceiptData(order, methodLabel, brand) {
    const qty = Math.max(1, parseInt(order.quantity, 10) || 1);
    const subtotal = Math.round(Number(order.amount) || 0);
    // Rincian HARUS selalu cocok: Subtotal + Biaya = Total.
    // - totalPaid tersimpan (order Pakasir): total = totalPaid, biaya = selisihnya.
    //   Jika setelan Pakasir "biaya ditanggung merchant", totalPaid == subtotal -> baris biaya
    //   tidak ditampilkan (bukan menampilkan biaya yang tidak dibayar customer).
    // - order lama / metode lain: pakai fee bila ada.
    let fee;
    let total;
    if (Number(order.totalPaid) > 0) {
        total = Math.round(Number(order.totalPaid));
        fee = Math.max(0, total - subtotal);
    } else {
        fee = Math.max(0, Math.round(Number(order.fee) || 0));
        total = subtotal + fee;
    }
    const product = String(order.productName || 'Produk Digital').toUpperCase();
    const variant = String(order.variantName || '').trim();
    // Hindari "DIGITALOCEAN 10 DROPLET - 10 DROPLET" bila nama produk sudah memuat varian.
    const showVariant = variant && !product.includes(variant.toUpperCase());
    const tail = shortTrx(order.orderId, brand.trxPrefix);
    return {
        trx: `#${brand.trxPrefix}-${tail}`,
        trxTail: tail,
        buyer: maskId(order.customerInfo && order.customerInfo.telegramUserId),
        product,
        productFull: showVariant ? `${product} - ${variant.toUpperCase()}` : product,
        variantSub: showVariant ? `${variant} · pengiriman otomatis` : 'Produk digital · pengiriman otomatis',
        method: String(methodLabel || 'QRIS').toUpperCase(),
        date: formatDate(order.paidAt || order.deliveredAt),
        qty,
        unitPrice: Math.round(subtotal / qty),
        subtotal,
        fee,
        total,
    };
}

// ------------------------------------------------------------------ caption
function buildCaption(d, brand, botUsername) {
    const L = '━━━━━━━━━━━━━━━';
    const lines = [
        '🧾 <b>STRUK PEMBELIAN — LUNAS</b> ✅',
        L,
        `👤 <b>ID Pembeli</b> : ${escHtml(d.buyer)}`,
        `📦 <b>Produk</b> : ${escHtml(d.productFull.length > 200 ? d.productFull.slice(0, 197) + '…' : d.productFull)}`,
        `💳 <b>Metode Bayar</b> : ${escHtml(d.method)}`,
        `📅 <b>Tanggal</b> : ${escHtml(d.date)}`,
        '',
        `💰 <b>Harga Satuan</b> : ${rp(d.unitPrice)}`,
        `🔢 <b>Jumlah</b> : ${d.qty}`,
    ];
    if (d.fee > 0) lines.push(`💸 <b>${escHtml(brand.feeLabel || 'Biaya QRIS')}</b> : ${rp(d.fee)}`);
    lines.push(L, `🧮 <b>Subtotal</b> : ${rp(d.subtotal)}`, `💵 <b>Total Bayar</b> : ${rp(d.total)}`, L);
    const store = escHtml(brand.displayName);
    lines.push(botUsername
        ? `🛒 Order otomatis 24 jam di <a href="https://t.me/${botUsername}">${store}</a>`
        : `🛒 Order otomatis 24 jam di ${store}`);
    // Nama produk sudah dibatasi 200 huruf, jadi caption selalu < 1024 (batas Telegram)
    // tanpa perlu memotong teks HTML (memotong HTML bisa merusak tag -> posting gagal).
    return lines.join('\n');
}

// ------------------------------------------------------------------ gambar (Canvas 2D standar)
function font(size, bold) {
    return `${bold ? 'bold ' : ''}${size}px ${FONT}`;
}

function rr(ctx, x, y, w, h, r) {
    const R = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + R, y);
    ctx.arcTo(x + w, y, x + w, y + h, R);
    ctx.arcTo(x + w, y + h, x, y + h, R);
    ctx.arcTo(x, y + h, x, y, R);
    ctx.arcTo(x, y, x + w, y, R);
    ctx.closePath();
}

function fitText(ctx, text, maxW) {
    const t = String(text == null ? '' : text);
    if (ctx.measureText(t).width <= maxW) return t;
    let s = t;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
}

function spacedWidth(ctx, t, sp) {
    const chars = Array.from(t);
    return chars.reduce((w, ch) => w + ctx.measureText(ch).width, 0) + sp * Math.max(0, chars.length - 1);
}

function spacedText(ctx, t, x, y, sp, align) {
    const prev = ctx.textAlign;
    const w = spacedWidth(ctx, t, sp);
    let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.textAlign = 'left';
    for (const ch of Array.from(t)) {
        ctx.fillText(ch, cx, y);
        cx += ctx.measureText(ch).width + sp;
    }
    ctx.textAlign = prev;
}

function drawHeart(ctx, x, y, s, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s / 24, s / 24);
    ctx.beginPath();
    ctx.moveTo(12, 21);
    ctx.bezierCurveTo(12, 21, 3, 15.5, 3, 9);
    ctx.bezierCurveTo(3, 6, 5.2, 4, 7.8, 4);
    ctx.bezierCurveTo(9.6, 4, 11.1, 5, 12, 6.5);
    ctx.bezierCurveTo(12.9, 5, 14.4, 4, 16.2, 4);
    ctx.bezierCurveTo(18.8, 4, 21, 6, 21, 9);
    ctx.bezierCurveTo(21, 15.5, 12, 21, 12, 21);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

function computeLayout(d) {
    const L = {};
    L.cardTop = PAD;
    L.hdrTop = L.cardTop + 8 + 30;
    L.okTop = L.hdrTop + 78 + 22;
    L.rowsTop = L.okTop + 94 + 24;
    L.rowsBottom = L.rowsTop + 5 * 44;
    L.secTop = L.rowsBottom + 14;
    L.tableTop = L.secTop + 21 + 14;
    L.nSum = d.fee > 0 ? 2 : 1;
    L.tableH = 44 + 66 + 6 + L.nSum * 32 + 14;
    L.totalTop = L.tableTop + L.tableH + 18;
    L.footTop = L.totalTop + 78 + 26;
    L.cardBottom = L.footTop + 72;
    L.cardH = L.cardBottom - L.cardTop;
    L.H = L.cardBottom + PAD;
    return L;
}

function receiptHeight(d) {
    return computeLayout(d).H;
}

// Menggambar struk pada koordinat logis (lebar W). Pemanggil yang mengatur skala.
function drawReceipt(ctx, d, brand, logo) {
    const L = computeLayout(d);
    const C = brand.colors;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // latar + kartu
    ctx.fillStyle = '#eef3f7';
    ctx.fillRect(0, 0, W, L.H);
    ctx.save();
    ctx.shadowColor = 'rgba(20,40,70,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    rr(ctx, CX, L.cardTop, CW, L.cardH, 22);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // garis gradasi atas (terpotong mengikuti sudut kartu)
    ctx.save();
    rr(ctx, CX, L.cardTop, CW, L.cardH, 22);
    ctx.clip();
    const bar = ctx.createLinearGradient(CX, 0, CX + CW, 0);
    bar.addColorStop(0, C.grad[0]);
    bar.addColorStop(1, C.grad[1]);
    ctx.fillStyle = bar;
    ctx.fillRect(CX, L.cardTop, CW, 8);
    ctx.restore();

    // header: logo + nama toko
    let tx;
    if (logo && logo.width && logo.height) {
        const h = 78;
        const w = Math.round(logo.width * h / logo.height);
        ctx.drawImage(logo, X0, L.hdrTop, w, h);
        tx = X0 + w + 18;
    } else {
        rr(ctx, X0, L.hdrTop, 78, 78, 20);
        const lg = ctx.createLinearGradient(X0, L.hdrTop, X0 + 78, L.hdrTop + 78);
        lg.addColorStop(0, C.grad[0]);
        lg.addColorStop(1, C.grad[1]);
        ctx.fillStyle = lg;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = font(44, true);
        ctx.textAlign = 'center';
        ctx.fillText(brand.monogram || brand.name1.charAt(0), X0 + 39, L.hdrTop + 55);
        ctx.textAlign = 'left';
        tx = X0 + 78 + 18;
    }
    ctx.font = font(34, true);
    ctx.fillStyle = C.name1;
    ctx.fillText(brand.name1, tx, L.hdrTop + 42);
    const w1 = ctx.measureText(brand.name1 + ' ').width;
    ctx.fillStyle = C.name2;
    ctx.fillText(brand.name2, tx + w1, L.hdrTop + 42);
    ctx.font = font(15, false);
    ctx.fillStyle = '#7a8699';
    ctx.fillText(brand.tagline, tx, L.hdrTop + 66);

    // kotak "Transaksi Berhasil"
    rr(ctx, X0 + 0.5, L.okTop + 0.5, CONTENT_W - 1, 93, 16);
    ctx.fillStyle = '#f0fbf6';
    ctx.fill();
    ctx.strokeStyle = '#cdeedd';
    ctx.lineWidth = 1;
    ctx.stroke();
    const tcx = X0 + 22 + 27;
    const tcy = L.okTop + 47;
    ctx.beginPath();
    ctx.arc(tcx, tcy, 27, 0, Math.PI * 2);
    ctx.fillStyle = '#1fae6b';
    ctx.fill();
    ctx.save();
    ctx.translate(tcx - 15, tcy - 15);
    ctx.scale(30 / 24, 30 / 24);
    ctx.beginPath();
    ctx.moveTo(5, 12.5);
    ctx.lineTo(9.5, 17);
    ctx.lineTo(19, 7.5);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#1f2a3d';
    ctx.font = font(24, true);
    ctx.fillText('Transaksi Berhasil', X0 + 94, L.okTop + 42);
    ctx.fillStyle = '#5b6b80';
    ctx.font = font(15, false);
    ctx.fillText('Pembayaran diterima dan produk digital telah dikirim otomatis.', X0 + 94, L.okTop + 66);
    ctx.font = font(14, true);
    const bw = spacedWidth(ctx, 'LUNAS', 1) + 28;
    const bx = X1 - 22 - bw;
    const by = tcy - 16;
    rr(ctx, bx, by, bw, 32, 16);
    ctx.fillStyle = '#1fae6b';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    spacedText(ctx, 'LUNAS', bx + 14, by + 21, 1, 'left');

    // baris info
    const rows = [
        ['No. Transaksi', d.trx],
        ['ID Pembeli', d.buyer],
        ['Produk', cleanForImage(d.productFull, 'PRODUK DIGITAL')],
        ['Metode Bayar', cleanForImage(d.method, 'QRIS')],
        ['Tanggal', d.date],
    ];
    rows.forEach(([k, v], i) => {
        const ry = L.rowsTop + i * 44;
        ctx.font = font(18, false);
        ctx.fillStyle = '#7a8699';
        ctx.fillText(k, X0, ry + 28);
        ctx.font = font(18, true);
        ctx.fillStyle = '#1f2a3d';
        ctx.fillText(fitText(ctx, v, CONTENT_W - 230), X0 + 230, ry + 28);
        if (i < rows.length - 1) {
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#e3e8ef';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(X0, ry + 44.5);
            ctx.lineTo(X1, ry + 44.5);
            ctx.stroke();
            ctx.restore();
        }
    });

    // Detail Produk
    ctx.font = font(21, true);
    ctx.fillStyle = '#1f2a3d';
    ctx.fillText('Detail Produk', X0, L.secTop + 19);

    const T = L.tableTop;
    ctx.save();
    rr(ctx, X0, T, CONTENT_W, L.tableH, 14);
    ctx.clip();
    ctx.fillStyle = '#f6f8fb';
    ctx.fillRect(X0, T, CONTENT_W, 44);
    ctx.restore();
    rr(ctx, X0 + 0.5, T + 0.5, CONTENT_W - 1, L.tableH - 1, 14);
    ctx.strokeStyle = '#e3e8ef';
    ctx.lineWidth = 1;
    ctx.stroke();

    const cProd = X0 + 20;
    const cSub = X1 - 20;
    const cQty = X1 - 20 - 170 - 35;
    const cPrice = X1 - 20 - 170 - 70;
    const prodW = (cPrice - 170) - cProd - 10;
    ctx.font = font(14, true);
    ctx.fillStyle = '#7a8699';
    spacedText(ctx, 'PRODUK', cProd, T + 28, 0.5, 'left');
    spacedText(ctx, 'HARGA SATUAN', cPrice, T + 28, 0.5, 'right');
    spacedText(ctx, 'QTY', cQty, T + 28, 0.5, 'center');
    spacedText(ctx, 'SUBTOTAL', cSub, T + 28, 0.5, 'right');

    const iy = T + 44;
    ctx.font = font(17, true);
    ctx.fillStyle = '#1f2a3d';
    ctx.fillText(fitText(ctx, cleanForImage(d.product, 'PRODUK DIGITAL'), prodW), cProd, iy + 30);
    ctx.font = font(13, false);
    ctx.fillStyle = '#8a95a6';
    ctx.fillText(fitText(ctx, cleanForImage(d.variantSub, 'Produk digital'), prodW), cProd, iy + 50);
    ctx.font = font(17, false);
    ctx.fillStyle = '#1f2a3d';
    ctx.textAlign = 'right';
    ctx.fillText(rp(d.unitPrice), cPrice, iy + 30);
    ctx.textAlign = 'center';
    ctx.fillText(String(d.qty), cQty, iy + 30);
    ctx.textAlign = 'right';
    ctx.fillText(rp(d.subtotal), cSub, iy + 30);

    const sums = [['Subtotal', d.subtotal]];
    if (d.fee > 0) sums.push([brand.feeLabel || 'Biaya QRIS', d.fee]);
    ctx.font = font(17, false);
    ctx.fillStyle = '#4d5b70';
    sums.forEach(([k, v], i) => {
        const sy = iy + 66 + 6 + i * 32 + 22;
        ctx.textAlign = 'left';
        ctx.fillText(k, cProd, sy);
        ctx.textAlign = 'right';
        ctx.fillText(rp(v), cSub, sy);
    });
    ctx.textAlign = 'left';

    // Total Pembayaran
    rr(ctx, X0, L.totalTop, CONTENT_W, 78, 14);
    const tg = ctx.createLinearGradient(X0, 0, X1, 0);
    tg.addColorStop(0, C.totalBg[0]);
    tg.addColorStop(1, C.totalBg[1]);
    ctx.fillStyle = tg;
    ctx.fill();
    ctx.fillStyle = C.dark;
    ctx.font = font(19, true);
    ctx.fillText('Total Pembayaran', X0 + 24, L.totalTop + 46);
    ctx.font = font(34, true);
    ctx.textAlign = 'right';
    ctx.fillText(rp(d.total), X1 - 24, L.totalTop + 51);
    ctx.textAlign = 'left';

    // footer
    const F = L.footTop;
    ctx.font = font(18, true);
    ctx.fillStyle = '#1f2a3d';
    const t1 = fitText(ctx, `Terima kasih telah berbelanja di ${brand.displayName}`, CONTENT_W - 40);
    const t1w = ctx.measureText(t1).width;
    const startX = W / 2 - (t1w + 26) / 2;
    ctx.fillText(t1, startX, F + 18);
    drawHeart(ctx, startX + t1w + 8, F + 2, 19, C.heart || C.grad[0]);
    ctx.font = font(14, false);
    ctx.fillStyle = '#7a8699';
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, brand.footer, CONTENT_W), W / 2, F + 44);
    ctx.textAlign = 'left';
    return L;
}

// ------------------------------------------------------------------ modul utama
function createTestimoni(cfg) {
    const brand = cfg.brand;
    let initPromise = null;      // inisialisasi SEKALI (aman bila 2 order lunas bersamaan)
    let canvasMod = null;
    let logoImg = null;
    let botUsername = null;

    function channel() {
        const c = String(cfg.channel == null ? '' : cfg.channel).trim();
        return (!c || c.toLowerCase() === 'off') ? null : c;
    }

    async function init() {
        try {
            canvasMod = require('@napi-rs/canvas');
        } catch (e) {
            console.warn('[TESTI] @napi-rs/canvas belum terpasang — testimoni diposting sebagai TEKS. Jalankan: npm install @napi-rs/canvas');
            canvasMod = null;
            return;
        }
        const dir = cfg.assetsDir;
        for (const file of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf']) {
            try {
                const ok = canvasMod.GlobalFonts.registerFromPath(path.join(dir, file));
                if (ok === false) console.warn(`[TESTI] font ${file} gagal didaftarkan (cek folder testimoni-assets).`);
            } catch (e) {
                console.warn(`[TESTI] font ${file} gagal dimuat:`, e.message);
            }
        }
        if (brand.logoFile) {
            try {
                logoImg = await canvasMod.loadImage(fs.readFileSync(path.join(dir, brand.logoFile)));
            } catch (e) {
                console.warn('[TESTI] logo tidak bisa dimuat, pakai monogram:', e.message);
                logoImg = null;
            }
        }
    }

    async function loadCanvas() {
        // Semua pemanggil menunggu promise yang SAMA -> logo & font pasti siap sebelum render.
        if (!initPromise) initPromise = init();
        await initPromise;
        return canvasMod;
    }

    async function renderPng(d) {
        const cv = await loadCanvas();
        if (!cv) return null;
        const H = receiptHeight(d);
        const canvas = cv.createCanvas(Math.round(W * SCALE), Math.round(H * SCALE));
        const ctx = canvas.getContext('2d');
        ctx.scale(SCALE, SCALE);
        drawReceipt(ctx, d, brand, logoImg);
        return typeof canvas.encode === 'function' ? await canvas.encode('png') : canvas.toBuffer('image/png');
    }

    // Mode senyap (default ON): testimoni dikirim tanpa bunyi agar subscriber tidak terganggu.
    async function isSilent() {
        if (typeof cfg.isSilent !== 'function') return true;
        try {
            return Boolean(await cfg.isSilent());
        } catch (e) {
            return true;
        }
    }

    function muteKeyboard() {
        return { inline_keyboard: [[{ text: MUTE_BUTTON_TEXT, callback_data: MUTE_CALLBACK }]] };
    }

    // Daftarkan handler tombol. Panggil SEBELUM middleware lain (lihat all.js) supaya
    // subscriber channel yang menekan tombol tidak ikut tercatat sebagai user bot.
    function attach(bot) {
        bot.action(MUTE_CALLBACK, async (ctx) => {
            await ctx.answerCbQuery(MUTE_HOWTO, { show_alert: true }).catch(() => {});
        });
        // /testigagal — daftar testimoni yang gagal permanen (khusus owner).
        bot.command('testigagal', async (ctx) => {
            const owners = (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
            if (!owners.includes(String(ctx.from.id))) return;
            if (!cfg.Order) return ctx.reply('Database tidak tersedia.');
            const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
            const rows = await cfg.Order.find({
                testiQueuedAt: { $gte: since },
                testiPostedAt: null,
                testiAttempts: { $gte: MAX_ATTEMPTS },
            }).sort({ testiQueuedAt: -1 }).limit(30).select('orderId testiLastError').lean().catch(() => []);
            if (!rows.length) return ctx.reply('✅ Tidak ada testimoni yang gagal dalam 7 hari terakhir.');
            const lines = rows.map((r, i) => `${i + 1}. ${r.orderId}\n   ${String(r.testiLastError || '-').slice(0, 80)}`);
            return ctx.reply(`⚠️ Testimoni gagal (${rows.length}):\n\n${lines.join('\n')}\n\nKirim ulang: /testiulang <ID order>`);
        });
        startSweeper(bot); // coba ulang otomatis testimoni yang belum terposting
    }

    async function getBotUsername(bot) {
        if (botUsername) return botUsername;
        try {
            botUsername = (bot.botInfo && bot.botInfo.username) || (await bot.telegram.getMe()).username || null;
        } catch (e) {
            botUsername = null;
        }
        return botUsername;
    }

    function methodFromOrder(o) {
        return String(o.paymentGateway || '').toLowerCase() === 'dana' ? 'DANA' : 'QRIS';
    }

    function errInfo(e) {
        const code = (e && (e.code || (e.response && e.response.error_code))) || null;
        const desc = (e && (e.description || (e.response && e.response.description) || e.message)) || String(e);
        const params = (e && (e.parameters || (e.response && e.response.parameters))) || {};
        return { code: typeof code === 'number' ? code : null, desc: String(desc), retryAfter: Number(params.retry_after) || 0 };
    }

    // Kirim 1 testimoni dengan coba ulang. Tidak pernah melempar error.
    async function sendWithRetry(bot, order, methodLabel) {
        const ch = channel();
        if (!ch) return { posted: false, reason: 'nonaktif', permanent: true };
        let d;
        let caption;
        try {
            d = buildReceiptData(order, methodLabel || methodFromOrder(order), brand);
            caption = buildCaption(d, brand, await getBotUsername(bot));
        } catch (e) {
            return { posted: false, reason: 'data order tidak valid: ' + e.message, permanent: true };
        }
        let png = null;
        try {
            png = await renderPng(d);
        } catch (e) {
            console.error('[TESTI] render gambar gagal, kirim teks saja:', e.message);
        }
        const silent = await isSilent();
        let useHtml = true;
        let last = null;
        for (let i = 0; i < SEND_TRIES; i++) {
            try {
                const text = useHtml ? caption : caption.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                const extra = { disable_notification: silent, reply_markup: muteKeyboard() };
                if (useHtml) extra.parse_mode = 'HTML';
                if (png) {
                    await bot.telegram.sendPhoto(ch, { source: png, filename: `testimoni-${d.trxTail}.png` }, { caption: text, ...extra });
                } else {
                    await bot.telegram.sendMessage(ch, text, { disable_web_page_preview: true, ...extra });
                }
                console.log(`[TESTI] ${d.trx} diposting ke ${ch}${png ? '' : ' (teks)'}${silent ? ' [senyap]' : ''}${i ? ` (percobaan ke-${i + 1})` : ''}`);
                return { posted: true, image: Boolean(png), silent };
            } catch (e) {
                last = errInfo(e);
                console.warn(`[TESTI] ${d.trx} gagal (percobaan ${i + 1}/${SEND_TRIES}): ${last.desc}`);
                if (last.code === 403 || /chat not found|not enough rights|not a member|bot was kicked/i.test(last.desc)) {
                    return { posted: false, reason: last.desc, permanent: true }; // bot belum admin/izin kurang
                }
                if (last.code === 400) {
                    if (useHtml && /parse entities|can't parse|unsupported start tag/i.test(last.desc)) {
                        useHtml = false;          // caption bermasalah -> kirim teks polos
                        continue;
                    }
                    if (png) {
                        png = null;               // gambar ditolak -> kirim sebagai teks
                        continue;
                    }
                    return { posted: false, reason: last.desc, permanent: true };
                }
                if (i < SEND_TRIES - 1) {
                    // 429 = dibatasi Telegram: tunggu sesuai retry_after. Lainnya (jaringan/5xx): jeda bertahap.
                    const wait = last.code === 429 ? Math.min((last.retryAfter || 5) * 1000 + 500, 65000) : BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
                    await sleep(wait);
                }
            }
        }
        return { posted: false, reason: last ? last.desc : 'tidak diketahui', permanent: false };
    }

    let lastOwnerAlert = 0;
    function alertOwner(text) {
        if (typeof cfg.notifyOwner !== 'function') return;
        if (Date.now() - lastOwnerAlert < 30 * 60 * 1000) return; // maks. 1 peringatan / 30 menit
        lastOwnerAlert = Date.now();
        Promise.resolve(cfg.notifyOwner(text)).catch(() => {});
    }
    // Gagal PERMANEN (tidak dicoba ulang) selalu dilaporkan — digabung per 1 menit supaya
    // tidak spam, tapi tiap ID order tetap disebut.
    const finalFails = [];
    let finalTimer = null;
    function alertFinal(orderId, reason) {
        if (typeof cfg.notifyOwner !== 'function') return;
        finalFails.push({ orderId, reason });
        if (finalTimer) return;
        finalTimer = setTimeout(() => {
            finalTimer = null;
            const items = finalFails.splice(0);
            const shown = items.slice(0, 25).map((x) => `• ${x.orderId} — ${String(x.reason).slice(0, 80)}`);
            if (items.length > 25) shown.push(`… dan ${items.length - 25} lainnya (/testigagal)`);
            Promise.resolve(cfg.notifyOwner(
                `⚠️ ${items.length} testimoni GAGAL diposting ke ${channel()} dan tidak dicoba ulang otomatis:\n\n${shown.join('\n')}\n\n` +
                'Pastikan bot ADMIN channel dengan izin "Post Messages", lalu kirim ulang: /testiulang <ID order>. Daftar lengkap: /testigagal'
            )).catch(() => {});
        }, 60 * 1000);
    }

    // Satu percobaan posting untuk order tertentu, dengan kunci anti-dobel di database.
    async function attempt(bot, orderId, methodLabel) {
        const Order = cfg.Order;
        const now = new Date();
        let order;
        const lockUntil = new Date(now.getTime() + LOCK_MS); // sekaligus "token" pemilik kunci
        try {
            order = await Order.findOneAndUpdate(
                {
                    orderId,
                    testiPostedAt: null,
                    $or: [{ testiLockUntil: null }, { testiLockUntil: { $lt: now } }],
                },
                { $set: { testiLockUntil: lockUntil }, $inc: { testiAttempts: 1 } },
                { new: true }
            ).lean();
        } catch (e) {
            console.error('[TESTI] gagal mengunci antrean:', e.message);
            return { posted: false, reason: e.message };
        }
        if (!order) return { posted: false, reason: 'sudah diposting / sedang diproses' };

        const res = await sendWithRetry(bot, order, methodLabel || order.testiMethod);
        try {
            if (res.posted) {
                // Tandai terposting apa pun kondisi kuncinya -> tidak akan diposting lagi.
                await Order.updateOne({ orderId }, { $set: { testiPostedAt: new Date() }, $unset: { testiLockUntil: '', testiLastError: '' } });
            } else {
                const upd = { $set: { testiLastError: String(res.reason).slice(0, 200) }, $unset: { testiLockUntil: '' } };
                if (res.permanent) upd.$set.testiAttempts = MAX_ATTEMPTS; // jangan diulang lagi
                // Hanya pemilik kunci yang boleh melepasnya.
                await Order.updateOne({ orderId, testiLockUntil: lockUntil }, upd);
            }
        } catch (e) {
            console.error('[TESTI] gagal menyimpan status antrean:', e.message);
        }
        if (!res.posted && res.reason !== 'nonaktif') {
            const again = !res.permanent && (order.testiAttempts || 0) < MAX_ATTEMPTS;
            if (again) {
                alertOwner(`⚠️ Testimoni order ${orderId} gagal diposting ke ${channel()}\nSebab: ${res.reason}\n\nAkan dicoba ulang otomatis tiap 10 menit.`);
            } else {
                alertFinal(orderId, res.reason);
            }
        }
        return res;
    }

    // Dipanggil sekali per order saat akun PERTAMA kali terkirim. Tidak pernah melempar error.
    async function enqueue(bot, order, methodLabel) {
        if (!channel() || !order) return { posted: false, reason: 'nonaktif' };
        if (!cfg.Order) return sendWithRetry(bot, order, methodLabel); // tanpa database: kirim langsung
        try {
            // Tandai antre di database dulu -> kalau bot restart sebelum terkirim, sapuan akan mengirimnya.
            await cfg.Order.updateOne(
                { orderId: order.orderId, testiQueuedAt: null },
                { $set: { testiQueuedAt: new Date(), testiMethod: methodLabel || methodFromOrder(order), testiAttempts: 0 } }
            );
        } catch (e) {
            console.error('[TESTI] gagal mencatat antrean:', e.message);
            return sendWithRetry(bot, order, methodLabel);
        }
        return attempt(bot, order.orderId, methodLabel);
    }

    // Kirim ulang manual oleh owner (mis. order lama sebelum fitur antrean ada).
    async function repost(bot, orderId) {
        if (!cfg.Order) return { posted: false, reason: 'database tidak tersedia' };
        const o = await cfg.Order.findOne({ orderId }).lean();
        if (!o) return { posted: false, reason: 'order tidak ditemukan' };
        if (o.status !== 'PAID') return { posted: false, reason: `status order ${o.status}, bukan PAID` };
        if (o.testiPostedAt) return { posted: false, reason: 'sudah pernah diposting', postedAt: o.testiPostedAt };
        const now = new Date();
        // JANGAN buka kunci yang sedang dipakai (mis. testimoni sedang menunggu antrean Telegram)
        // -> dulu ini membuat testimoni terposting dua kali.
        const r = await cfg.Order.updateOne(
            { orderId, testiPostedAt: null, $or: [{ testiLockUntil: null }, { testiLockUntil: { $lt: now } }] },
            { $set: { testiQueuedAt: o.testiQueuedAt || now, testiMethod: o.testiMethod || methodFromOrder(o), testiAttempts: 0 } }
        );
        const matched = r && (r.matchedCount !== undefined ? r.matchedCount : r.modifiedCount);
        if (!matched) return { posted: false, reason: 'testimoni ini sedang diproses, tunggu beberapa menit lalu cek channel' };
        return attempt(bot, orderId);
    }

    // Sapu ulang testimoni yang belum terposting (gagal sementara / bot sempat restart).
    let sweeping = false;
    async function sweep(bot) {
        if (sweeping || !cfg.Order || !channel()) return;
        sweeping = true;
        try {
            const now = new Date();
            const pending = await cfg.Order.find({
                testiQueuedAt: { $gte: new Date(now.getTime() - SWEEP_WINDOW_H * 3600 * 1000) },
                testiPostedAt: null,
                testiAttempts: { $lt: MAX_ATTEMPTS },
                $or: [{ testiLockUntil: null }, { testiLockUntil: { $lt: now } }],
            }).sort({ testiQueuedAt: 1 }).limit(10).select('orderId testiMethod').lean();
            for (const p of pending) {
                await attempt(bot, p.orderId, p.testiMethod);
                await sleep(4000); // jaga di bawah batas posting channel Telegram (20/menit)
            }
        } catch (e) {
            console.error('[TESTI] sapuan gagal:', e.message);
        } finally {
            sweeping = false;
        }
    }

    function startSweeper(bot) {
        if (!cfg.Order) return;
        setTimeout(() => sweep(bot), 90 * 1000);
        setInterval(() => sweep(bot), SWEEP_EVERY_MS);
    }

    // Kompatibel dengan pemanggilan lama.
    const post = enqueue;

    return { enqueue, post, repost, sweep, attach, renderPng, buildReceiptData: (o, m) => buildReceiptData(o, m, brand), buildCaption: (d, u) => buildCaption(d, brand, u) };
}

module.exports = createTestimoni;
module.exports.drawReceipt = drawReceipt;
module.exports.receiptHeight = receiptHeight;
module.exports.buildReceiptData = buildReceiptData;
module.exports.buildCaption = buildCaption;
module.exports.maskId = maskId;
module.exports.rp = rp;
module.exports.W = W;
module.exports.SCALE = SCALE;
module.exports.FONT = FONT;
module.exports.FONT_FAMILY = FONT_FAMILY;
module.exports.cleanForImage = cleanForImage;
module.exports.MUTE_CALLBACK = MUTE_CALLBACK;
module.exports.MUTE_HOWTO = MUTE_HOWTO;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
