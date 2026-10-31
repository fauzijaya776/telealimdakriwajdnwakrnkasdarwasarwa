// /setagpkey & kawan-kawan: key AutoGoPay diatur lewat Telegram tanpa env hosting.
// Semua key di sini PALSU.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

process.env.BOT_TOKEN = '123456:TOKEN-UJI';
delete process.env.AUTOGOPAY_API_KEY; delete process.env.PAYMENT_PROVIDER;

// Settings tiruan (satu dokumen global-settings)
let doc = { identifier: 'global-settings' };
const FakeSettings = {
  __fake: true,
  findOne: () => ({ lean: async () => ({ ...doc }) }),
  updateOne: async (q, u) => { Object.assign(doc, u.$set || {}); for (const k of Object.keys(u.$unset || {})) delete doc[k]; return { acknowledged: true }; },
};
const settings = require('../qris_settings');
settings._setModelForTest(FakeSettings);

const KEY = 'agp_' + 'a1b2c3d4'.repeat(8); // palsu
const MASKED = settings.mask(KEY);

test('key disimpan terenkripsi, bisa dibaca kembali, dan env tetap didahulukan', async () => {
  await settings.saveKey(KEY, 42);
  assert.ok(doc.agp_key_enc && !doc.agp_key_enc.includes(KEY) && !doc.agp_key_enc.includes('a1b2c3d4'), 'tidak tersimpan sebagai teks biasa');
  assert.equal(settings.apiKey(), KEY); assert.equal(settings.keySource(), 'telegram');
  assert.equal(settings.activeProvider(), 'autogopay', 'key ada → otomatis AutoGoPay');
  process.env.AUTOGOPAY_API_KEY = 'agp_dari_env_xxxxxxxxxxxxxxxx';
  assert.equal(settings.apiKey(), 'agp_dari_env_xxxxxxxxxxxxxxxx'); assert.equal(settings.keySource(), 'env');
  delete process.env.AUTOGOPAY_API_KEY;
});

test('gateway: /agpgateway pakasir mengalahkan otomatis; env PAYMENT_PROVIDER mengalahkan semuanya', async () => {
  await settings.setProvider('pakasir'); assert.equal(settings.activeProvider(), 'pakasir');
  process.env.PAYMENT_PROVIDER = 'autogopay'; assert.equal(settings.activeProvider(), 'autogopay'); delete process.env.PAYMENT_PROVIDER;
  await settings.setProvider('auto'); assert.equal(settings.activeProvider(), 'autogopay');
});

test('BOT_TOKEN berganti → key lama tidak bisa dibuka (aman), status memberi tahu', async () => {
  process.env.BOT_TOKEN = '999:TOKEN-BARU';
  await settings.ensureLoaded(true);
  assert.equal(settings.apiKey(), null); assert.equal(settings.info().decryptFailed, true);
  assert.equal(settings.activeProvider(), 'pakasir', 'tanpa key → jatuh ke Pakasir, bukan error');
  process.env.BOT_TOKEN = '123456:TOKEN-UJI'; await settings.ensureLoaded(true);
  assert.equal(settings.apiKey(), KEY);
  await settings.clearKey(); assert.equal(settings.apiKey(), null);
});

// ---- jalankan blok perintah asli dari all.js di bot tiruan ----
const src = fs.readFileSync(path.join(__dirname, '..', 'all.js'), 'utf8');
const block = src.slice(src.indexOf('const qrisSettings = require'), src.indexOf('// =================================================================\n// BAGIAN C'));
let verifyResult = { ok: true };
function makeBot() {
  const handlers = {};
  const context = {
    bot: { command: (name, fn) => { handlers[name] = fn; } },
    require: (m) => (m === './qris_settings' ? settings : { verifyKey: async () => verifyResult }),
    ownerIdList: () => ['42'], moment: require('moment-timezone'), console,
  };
  vm.createContext(context); vm.runInContext(block, context);
  return handlers;
}
function ctx({ from = 42, chat = 'private', text }) {
  const out = { replies: [], deleted: 0 };
  return Object.assign(out, {
    from: { id: from }, chat: { type: chat }, message: { text },
    reply: async (t) => { out.replies.push(t); }, deleteMessage: async () => { out.deleted += 1; },
  });
}

test('/setagpkey: pesan selalu dihapus; bukan owner diabaikan; grup ditolak; format & verifikasi dicek', async () => {
  const h = makeBot();
  let c = ctx({ from: 7, text: `/setagpkey ${KEY}` }); await h.setagpkey(c);
  assert.equal(c.deleted, 1); assert.equal(c.replies.length, 0); assert.equal(doc.agp_key_enc, undefined);
  c = ctx({ chat: 'supergroup', text: `/setagpkey ${KEY}` }); await h.setagpkey(c);
  assert.equal(c.deleted, 1); assert.match(c.replies[0], /BOCOR/); assert.equal(doc.agp_key_enc, undefined);
  c = ctx({ text: '/setagpkey bukan-key' }); await h.setagpkey(c); assert.match(c.replies[0], /Format/);
  verifyResult = { ok: false, reason: 'key ditolak AutoGoPay' };
  c = ctx({ text: `/setagpkey ${KEY}` }); await h.setagpkey(c);
  assert.match(c.replies[0], /TIDAK disimpan/); assert.equal(doc.agp_key_enc, undefined);
});

test('/setagpkey berhasil → tersimpan, balasan hanya menampilkan key tersamar; /agpgateway & /hapusagpkey', async () => {
  const h = makeBot(); verifyResult = { ok: true };
  let c = ctx({ text: `/setagpkey@cloudalimbot ${KEY}` }); await h.setagpkey(c);
  assert.equal(c.deleted, 1); assert.ok(doc.agp_key_enc);
  assert.match(c.replies[0], /disimpan/); assert.ok(c.replies[0].includes(MASKED)); assert.ok(!c.replies[0].includes(KEY), 'key utuh tidak pernah dikirim balik');
  assert.match(c.replies[0], /Gateway order baru: AutoGoPay/);
  c = ctx({ text: '/agpgateway pakasir' }); await h.agpgateway(c); assert.match(c.replies[0], /Gateway order baru: Pakasir/);
  c = ctx({ text: '/agpgateway auto' }); await h.agpgateway(c); assert.match(c.replies[0], /AutoGoPay/);
  c = ctx({ from: 7, text: '/agpkey' }); await h.agpkey(c); assert.equal(c.replies.length, 0, 'bukan owner tidak bisa melihat status');
  c = ctx({ text: '/hapusagpkey' }); await h.hapusagpkey(c); assert.equal(doc.agp_key_enc, undefined); assert.match(c.replies[0], /belum ada/);
  c = ctx({ text: '/agpgateway autogopay' }); await h.agpgateway(c); assert.match(c.replies[0], /Belum ada API key/);
});
