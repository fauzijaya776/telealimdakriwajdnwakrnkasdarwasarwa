// node --test test/*.test.js  — AutoGoPay & aturan anti-blokir (API dan database tiruan).
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.AUTOGOPAY_API_KEY = 'agp_test';
let reply = null; const calls = [];
axios.post = async (url, body, opt) => { calls.push({ url, body, auth: opt.headers.Authorization }); return typeof reply === 'function' ? reply(url, body) : reply; };
const agp = require('../qris_autogopay');
const gw = require('../qris_gateway');

const at = (ms, off) => new Date(ms + off * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

test('createTransaction: txnId berawalan agp:, tanpa biaya, expiry UTC+8 terbaca 15 menit', async () => {
  const exp = Date.now() + 15 * 60e3;
  reply = { status: 200, data: { success: true, data: { transaction_id: 'T1', order_id: 'AUTOGOPAY-1', amount: 5000, qr_string: '000201QR', expiry_time: at(exp, 8) } } };
  const t = await agp.createTransaction('ALIM-1-1', 5000);
  assert.equal(t.txnId, 'agp:T1'); assert.equal(t.fee, 0); assert.equal(t.totalBayar, 5000);
  assert.ok(Math.abs(new Date(t.expiredAt).getTime() - exp) < 2000);
  assert.equal(calls.at(-1).auth, 'Bearer agp_test'); assert.ok(calls.at(-1).url.endsWith('/qris/generate'));
});

test('createTransaction: gagal / nominal beda → error, tanpa retry', async () => {
  calls.length = 0;
  reply = { status: 502, data: { success: false, message: 'down' } };
  await assert.rejects(agp.createTransaction('X', 5000)); assert.equal(calls.length, 1);
  reply = { status: 200, data: { success: true, data: { transaction_id: 'T', qr_string: 'Q', amount: 1 } } };
  await assert.rejects(agp.createTransaction('X', 5000));
});

test('checkPaymentStatus membaca respons success:false (pending/expire/cancel) dan success:true (settlement)', async () => {
  for (const [raw, ok, want] of [['pending', false, 'pending'], ['expire', false, 'expired'], ['cancel', false, 'canceled'], ['settlement', true, 'completed']]) {
    reply = { status: 200, data: { success: ok, message: 'Transaction status: ' + raw, data: { transaction_id: 'T1', transaction_status: raw, transaction_time: '2026-10-31 17:00:00' } } };
    assert.equal((await agp.checkPaymentStatus('agp:T1')).status, want, raw);
  }
  assert.equal(calls.at(-1).body.transaction_id, 'T1', 'awalan agp: dibuang sebelum dikirim');
  reply = { status: 503, data: {} }; assert.equal(await agp.checkPaymentStatus('agp:T1'), null, 'API error → null (bukan gagal bayar)');
  reply = { status: 200, data: { success: true, data: { transaction_id: 'LAIN', transaction_status: 'settlement' } } };
  assert.equal(await agp.checkPaymentStatus('agp:T1'), null, 'jawaban untuk transaksi lain ditolak');
});

test('gateway: order lama Pakasir tetap ke Pakasir, AutoGoPay ke AutoGoPay', async () => {
  const pakasir = require('../qris_pakasir'); let pk = 0;
  pakasir.checkPaymentStatus = async () => { pk += 1; return { status: 'pending' }; };
  calls.length = 0;
  await gw.checkPaymentStatus('pakasir-123'); assert.equal(pk, 1); assert.equal(calls.length, 0);
  reply = { status: 200, data: { success: false, data: { transaction_status: 'pending' } } };
  await gw.checkPaymentStatus('agp:T9'); assert.equal(calls.length, 1);
  assert.equal(await gw.cancelTransaction('pakasir-123'), false, 'Pakasir tidak dibatalkan di provider');
  delete process.env.PAYMENT_PROVIDER; assert.equal(gw.active(), 'autogopay');
  process.env.PAYMENT_PROVIDER = 'pakasir'; assert.equal(gw.active(), 'pakasir'); delete process.env.PAYMENT_PROVIDER;
});

// Order tiruan untuk aturan anti-blokir
function fakeOrder(docs) {
  const match = (d, q) => Object.entries(q).every(([k, v]) => {
    const val = k.split('.').reduce((o, p) => (o == null ? o : o[p]), d);
    if (v && typeof v === 'object' && '$gte' in v) return val >= v.$gte;
    return val === v;
  });
  return {
    find: (q) => { let r = docs.filter((d) => match(d, q)); const c = { sort: () => c, limit: (n) => { r = r.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, n); return c; }, lean: async () => r }; return c; },
    countDocuments: async (q) => docs.filter((d) => match(d, q)).length,
  };
}
const ago = (min) => new Date(Date.now() - min * 60e3);
const o = (uid, status, min) => ({ orderId: `ALIM-${uid}-${min}`, status, createdAt: ago(min), paymentGateway: 'pakasir', customerInfo: { telegramUserId: String(uid) } });

test('anti-blokir: tagihan aktif, jeda, tak dibayar beruntun, batas harian, rem darurat, kill switch', async () => {
  assert.equal((await gw.guardNewQris(fakeOrder([o(1, 'PENDING', 2)]), 1)).live.orderId, 'ALIM-1-2');
  assert.match((await gw.guardNewQris(fakeOrder([o(1, 'CANCELLED', 1)]), 1)).error, /Tunggu/);
  assert.deepEqual(await gw.guardNewQris(fakeOrder([o(1, 'CANCELLED', 10), o(1, 'PAID', 30)]), 1), {});
  assert.match((await gw.guardNewQris(fakeOrder([1, 2, 3, 4, 5].map((i) => o(2, 'EXPIRED', 20 + i))), 2)).error, /tidak dibayar/);
  assert.match((await gw.guardNewQris(fakeOrder([1, 2, 3, 4, 5, 6, 7, 8].map((i) => o(3, i === 1 ? 'PAID' : 'EXPIRED', 20 + i))), 3)).error, /per hari/);
  const flood = Array.from({ length: 30 }, (_, i) => o(100 + i, 'EXPIRED', 0.2));
  const g = await gw.guardNewQris(fakeOrder(flood), 9); assert.ok(g.brake); assert.match(g.error, /ramai/);
  process.env.PAYMENT_ENABLED = '0'; assert.match((await gw.guardNewQris(fakeOrder([]), 9)).error, /ditutup/); delete process.env.PAYMENT_ENABLED;
  assert.deepEqual(await gw.guardNewQris(fakeOrder([]), 9), {});
});
