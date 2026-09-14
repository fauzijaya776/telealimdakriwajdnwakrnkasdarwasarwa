const {
  Markup
} = require('telegraf');
const {
  Product
} = require('./db');
const {
  createTransfer,
  getProfile
} = require('./qris_tokopay');

const userStates = {};
const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim());

const adminMiddleware = (ctx, next) => {
  if (ADMIN_IDS.includes(ctx.from.id.toString())) {
    return next();
  }
  ctx.reply('❌ Maaf, Anda tidak memiliki akses admin.');
};

// --- FUNGSI-FUNGSI DIBAWAH INI SUDAH DIREVISI MENGGUNAKAN MONGOOSE ---

async function addStock(productId, variantSlug, stockToAdd, ctx) {
  try {
    const newStockItems = stockToAdd.filter(line => line.trim() !== '');
    if (newStockItems.length === 0) return ctx.reply('❌ Tidak ada stok yang valid untuk ditambahkan.');

    // REVISI: Menggunakan Mongoose untuk menambahkan stok
    const result = await Product.updateOne(
      {
        id: productId, "variants.slug": variantSlug
      },
      {
        $push: {
          "variants.$.stock": {
            $each: newStockItems
          }
        }
      }
    );

    if (result.matchedCount === 0) {
      return ctx.reply('❌ Gagal: Produk atau varian tidak ditemukan.');
    }

    // Ambil data terbaru untuk pesan balasan
    const updatedProduct = await Product.findOne({
      id: productId
    }).lean();
    const updatedVariant = updatedProduct.variants.find(v => v.slug === variantSlug);

    ctx.reply(
      `✅ Berhasil menambahkan ${newStockItems.length} stok untuk *${updatedProduct.name}* - *${updatedVariant.name}*.\nTotal stok sekarang: ${updatedVariant.stock.length}`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Kembali Ke Menu', 'admin_menu')
        ]).reply_markup
      }
    );

  } catch (error) {
    console.error('Error adding stock:', error);
    ctx.reply(`❌ Gagal menambahkan stok. \nPesan Error: ${error.message}`);
  }
}

async function deleteProduct(productId) {
  // REVISI: Menggunakan Mongoose untuk menghapus produk
  await Product.deleteOne({
    id: productId
  });
}

async function getAdminMenuMessageAndKeyboard() {
  const message = '⚙️ *Panel Admin*\n\n' +
  'Silakan pilih opsi manajemen:';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Stok', 'admin_add_stock_select_product_1')],
    [Markup.button.callback('➖ Ambil Stok', 'admin_take_stock_select_product_1')],
    [Markup.button.callback('👁️ Lihat Stok', 'admin_view_stock_select_product_1')],
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_product')],
    [Markup.button.callback('✍️ Edit Produk', 'admin_edit_product_list_1')],
    [Markup.button.callback('💰 Harga Grosir', 'admin_bulk_select_product_1')],
    [Markup.button.callback('📜 Kelola SNK', 'admin_snk_select_product_1')],
    [Markup.button.callback('❌ Hapus Produk', 'admin_delete_product_list_1')],
    [Markup.button.callback('🚀 Broadcast', 'admin_broadcast')],
    [Markup.button.callback('💳 Buat Transfer', 'admin_tf')],
    [Markup.button.callback('🧾 Cek Saldo', 'admin_profile')],
    [Markup.button.callback('⬅️ Kembali ke Menu Utama', 'back_to_start')]
  ]);

  return {
    message,
    keyboard
  };
}

async function getProductManagementList(action, page = 1) {
  // REVISI: Mengambil data dari MongoDB
  const products = await Product.find({}).sort({
    name: 1
  }).lean();

  const productsPerPage = 10;
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  let title = '';
  if (action === 'edit') title = 'Pengeditan';
  else if (action === 'delete') title = 'Penghapusan';
  else if (action === 'snk') title = 'Manajemen SNK';
  else if (action === 'bulk') title = 'Harga Grosir';

  let message = `📚 *Daftar Produk untuk ${title}:*\n\n`;
  const keyboardButtons = [];

  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    message += `*${productNumber}. ${p.name}*\n`;
    keyboardButtons.push(
      Markup.button.callback(`${productNumber}`, `admin_${action}_product_${p.id}_page_${page}`)
    );
  });

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️ Sebelumnya', `admin_${action}_product_list_${page - 1}`));
  }
  if (endIndex < products.length) {
    navigationButtons.push(Markup.button.callback('➡️ Berikutnya', `admin_${action}_product_list_${page + 1}`));
  }

  const keyboard = [
    keyboardButtons,
    navigationButtons,
    [Markup.button.callback('⬅️ Kembali', 'admin_menu')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}

async function getEditProductDetails(productId, page) {
  try {
    // REVISI: Mengambil satu produk dari MongoDB
    const product = await Product.findOne({
      id: productId
    }).lean();
    if (!product) throw new Error('Produk tidak ditemukan');

    let message = `✍️ *Edit Produk: ${product.name}*\n\n` +
    `*Deskripsi:* ${product.description}\n\n` +
    `*Varian & Harga:*\n`;

    // Baris-baris ini akan menampung tombol-tombol yang akan kita buat
    const keyboardRows = [
      [Markup.button.callback('📝 Edit Nama & Deskripsi', `admin_edit_name_desc_${productId}_page_${page}`)],
      [Markup.button.callback('➕ Tambah Varian Baru', `admin_add_variant_${productId}_page_${page}`)],
    ];

    // --- PERUBAHAN DIMULAI DI SINI ---

    // Kita akan langsung membuat dan menambahkan tombol ke keyboardRows di dalam loop ini
    product.variants.forEach((v, index) => {
      const stockCount = Array.isArray(v.stock) ? v.stock.length: 0;
      const snkStatus = (v.snk && v.snk !== '-') ? '✅ Aktif': '❌ Tidak Aktif';
      message += `├ ${v.name}: Rp ${v.price.toLocaleString('id-ID')} | Stok: ${stockCount} | SNK: ${snkStatus}\n`;

      const buttonRow = [
        // Menggunakan pola 'action:productId:slug:page'
        Markup.button.callback(`📝 Edit Varian ${index + 1}`, `admin_edit_variant:${productId}:${v.slug}:${page}`),
        Markup.button.callback(`🗑️ Hapus`, `admin_delete_variant_confirm:${productId}:${v.slug}:${page}`)
      ];
      keyboardRows.push(buttonRow);
    });

    message += '\n';
    keyboardRows.push([Markup.button.callback('⬅️ Kembali', `admin_edit_product_list_${page}`)]);

    return {
      message,
      keyboard: Markup.inlineKeyboard(keyboardRows)
    };
  } catch (error) {
    console.error('Error in getEditProductDetails:', error);
    return {
      message: '❌ Produk tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `admin_edit_product_list_${page}`)])
    };
  }
}

async function getAddStockProductList(page = 1) {
  // REVISI: Mengambil data dari MongoDB
  const products = await Product.find({}).sort({
    name: 1
  }).lean();

  const productsPerPage = 5; // Menyamakan jumlah per halaman seperti menu lain
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  // --- BLOK KODE YANG DIUBAH DIMULAI DI SINI ---
  let message = '👇 *Tambah Stok*\n\nPilih produk yang akan ditambahkan stoknya:\n\n';
  const keyboardButtons = []; // Untuk menampung tombol angka [1], [2], [3], ...

  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    message += `*${productNumber}. ${p.name}*\n`; // Membuat daftar bernomor di teks pesan

    // Membuat tombol dengan angka yang sesuai
    keyboardButtons.push(
      Markup.button.callback(String(productNumber), `admin_add_stock_select_variant_${p.id}_1`)
    );
  });
  // --- AKHIR BLOK KODE YANG DIUBAH ---

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️', `admin_add_stock_select_product_${page - 1}`));
  }
  if (endIndex < products.length) {
    navigationButtons.push(Markup.button.callback('➡️', `admin_add_stock_select_product_${page + 1}`));
  }

  const keyboard = [
    keyboardButtons,
    // Menampilkan semua tombol angka dalam satu baris
    navigationButtons,
    [Markup.button.callback('⬅️ Batal', 'admin_menu')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}

async function getAddStockVariantList(productId, page = 1) {
  // REVISI: Mengambil satu produk dari MongoDB
  const product = await Product.findOne({
    id: productId
  }).lean();

  const variantsPerPage = 5;
  const startIndex = (page - 1) * variantsPerPage;
  const endIndex = startIndex + variantsPerPage;
  const paginatedVariants = product.variants.slice(startIndex, endIndex);

  const message = `👇 *Tambah Stok: ${product.name}*\n\nPilih varian yang akan ditambahkan stoknya:`;
  const keyboardButtons = paginatedVariants.map(v => {
    const stockCount = Array.isArray(v.stock) ? v.stock.length: 0;
    return [Markup.button.callback(`${v.name} (Stok: ${stockCount})`, `admin_add_stock_final:${product.id}:${v.slug}`)];
  });

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️', `admin_add_stock_select_variant_${productId}_${page - 1}`));
  }
  if (endIndex < product.variants.length) {
    navigationButtons.push(Markup.button.callback('➡️', `admin_add_stock_select_variant_${productId}_${page + 1}`));
  }

  const keyboard = [
    ...keyboardButtons,
    navigationButtons,
    [Markup.button.callback('⬅️ Kembali ke Produk', 'admin_add_stock_select_product_1')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}

/* ========================= AMBIL STOK ========================= */
async function getTakeStockProductList(page = 1) {
  const products = await Product.find({}).sort({ name: 1 }).lean();
  const productsPerPage = 5;
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  let message = '👇 *Ambil Stok*\n\nPilih produk yang stoknya akan diambil:\n\n';
  const keyboardButtons = [];
  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    message += `*${productNumber}. ${p.name}*\n`;
    keyboardButtons.push(Markup.button.callback(String(productNumber), `admin_take_stock_select_variant_${p.id}_1`));
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `admin_take_stock_select_product_${page - 1}`));
  if (endIndex < products.length) navigationButtons.push(Markup.button.callback('➡️', `admin_take_stock_select_product_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([keyboardButtons, navigationButtons, [Markup.button.callback('⬅️ Batal', 'admin_menu')]])
  };
}

async function getTakeStockVariantList(productId, page = 1) {
  const product = await Product.findOne({ id: productId }).lean();
  if (!product) return { message: '❌ Produk tidak ditemukan.', keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin_menu')]]) };

  const variantsPerPage = 5;
  const startIndex = (page - 1) * variantsPerPage;
  const endIndex = startIndex + variantsPerPage;
  const paginatedVariants = product.variants.slice(startIndex, endIndex);

  const message = `👇 *Ambil Stok: ${product.name}*\n\nPilih varian yang stoknya akan diambil:`;
  const keyboardButtons = paginatedVariants.map(v => {
    const stockCount = Array.isArray(v.stock) ? v.stock.length : 0;
    return [Markup.button.callback(`${v.name} (Stok: ${stockCount})`, `admin_take_stock_final:${product.id}:${v.slug}`)];
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `admin_take_stock_select_variant_${productId}_${page - 1}`));
  if (endIndex < product.variants.length) navigationButtons.push(Markup.button.callback('➡️', `admin_take_stock_select_variant_${productId}_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([...keyboardButtons, navigationButtons, [Markup.button.callback('⬅️ Kembali ke Produk', 'admin_take_stock_select_product_1')]])
  };
}

/** Ambil (keluarkan) sejumlah stok dari sebuah varian dan kirimkan ke admin. */
async function takeStock(productId, variantSlug, count, ctx) {
  try {
    const numCount = parseInt(count, 10);
    if (isNaN(numCount) || numCount <= 0) {
      return ctx.reply('❌ Jumlah tidak valid. Kirim angka lebih dari 0.');
    }
    const product = await Product.findOne({ id: productId });
    if (!product) return ctx.reply('❌ Produk tidak ditemukan.');
    const variant = product.variants.find(v => v.slug === variantSlug);
    if (!variant) return ctx.reply('❌ Varian tidak ditemukan.');

    const tersedia = Array.isArray(variant.stock) ? variant.stock.length : 0;
    if (tersedia < numCount) {
      return ctx.reply(`❌ Stok tidak cukup. Tersedia ${tersedia}, diminta ${numCount}.`);
    }

    // Ambil dari awal array lalu simpan (varian bukan .lean(), jadi bisa disave).
    const taken = variant.stock.splice(0, numCount);
    await product.save();

    const header = `✅ *Berhasil ambil ${numCount} stok*\n` +
      `*Produk:* ${product.name}\n*Varian:* ${variant.name}\n*Sisa stok:* ${variant.stock.length}\n`;

    if (numCount <= 20) {
      const list = taken.map((it, i) => `${i + 1}. ${it}`).join('\n');
      await ctx.reply(header + '\n```\n' + list + '\n```', { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(header, { parse_mode: 'Markdown' });
      await ctx.replyWithDocument({
        source: Buffer.from(taken.join('\n'), 'utf-8'),
        filename: `ambil_${variantSlug}_${Date.now()}.txt`
      });
    }
  } catch (error) {
    console.error('takeStock error:', error);
    await ctx.reply('❌ Terjadi kesalahan saat mengambil stok.');
  }
}

/* ========================= LIHAT STOK (VIEW-ONLY, TIDAK DIAMBIL) ========================= */
// Format satu baris akun agar lebih rapi (mirror formatAccountItem di all.js).
function formatStockLineForView(item) {
  if (!item || typeof item !== 'string') return String(item ?? '');
  const allLines = item.split(/\r?\n/);
  const firstLine = allLines[0];
  const extra = allLines.slice(1).filter(l => l.trim());
  if (firstLine.includes('dop_v1')) {
    const parts = firstLine.split('|').map(p => p.trim());
    const labels = ['api key', 'email', 'password', '2fa'];
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      out.push(`${labels[i] || `field${i + 1}`} = ${parts[i]}`);
    }
    if (extra.length) out.push(...extra);
    return out.join('\n');
  }
  if (firstLine.includes('|')) {
    const parts = firstLine.split('|').map(p => p.trim()).filter(Boolean);
    const out = [...parts];
    if (extra.length) out.push(...extra);
    return out.join('\n');
  }
  return item;
}

async function getViewStockProductList(page = 1) {
  const products = await Product.find({}).sort({ name: 1 }).lean();
  const productsPerPage = 5;
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  let message = '👁️ *Lihat Stok*\n\nPilih produk untuk melihat isi stoknya (stok TIDAK akan diambil/dihapus):\n\n';
  const keyboardButtons = [];
  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    const totalStock = (Array.isArray(p.variants) ? p.variants : []).reduce((s, v) => s + (Array.isArray(v.stock) ? v.stock.length : 0), 0);
    message += `*${productNumber}. ${p.name}* → x${totalStock}\n`;
    keyboardButtons.push(Markup.button.callback(String(productNumber), `admin_view_stock_select_variant_${p.id}_1`));
  });
  if (paginatedProducts.length === 0) message += '_Tidak ada produk._';

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `admin_view_stock_select_product_${page - 1}`));
  if (endIndex < products.length) navigationButtons.push(Markup.button.callback('➡️', `admin_view_stock_select_product_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([keyboardButtons, navigationButtons, [Markup.button.callback('⬅️ Batal', 'admin_menu')]])
  };
}

async function getViewStockVariantList(productId, page = 1) {
  const product = await Product.findOne({ id: productId }).lean();
  if (!product) return { message: '❌ Produk tidak ditemukan.', keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin_menu')]]) };

  const variantsPerPage = 5;
  const startIndex = (page - 1) * variantsPerPage;
  const endIndex = startIndex + variantsPerPage;
  const paginatedVariants = product.variants.slice(startIndex, endIndex);

  const message = `👁️ *Lihat Stok: ${product.name}*\n\nPilih varian untuk menampilkan isi stoknya:`;
  const keyboardButtons = paginatedVariants.map(v => {
    const stockCount = Array.isArray(v.stock) ? v.stock.length : 0;
    return [Markup.button.callback(`${v.name} (Stok: ${stockCount})`, `admin_view_stock_show:${product.id}:${v.slug}`)];
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `admin_view_stock_select_variant_${productId}_${page - 1}`));
  if (endIndex < product.variants.length) navigationButtons.push(Markup.button.callback('➡️', `admin_view_stock_select_variant_${productId}_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([...keyboardButtons, navigationButtons, [Markup.button.callback('⬅️ Kembali ke Produk', 'admin_view_stock_select_product_1')]])
  };
}

/** Tampilkan isi stok sebuah varian ke admin TANPA mengambil/menghapus apa pun. */
async function viewStock(productId, variantSlug, ctx) {
  try {
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) return ctx.reply('❌ Produk tidak ditemukan.');
    const variant = (product.variants || []).find(v => v.slug === variantSlug);
    if (!variant) return ctx.reply('❌ Varian tidak ditemukan.');

    const stock = Array.isArray(variant.stock) ? variant.stock : [];
    const total = stock.length;
    const header = `👁️ *Isi Stok (view-only, tidak diambil)*\n` +
      `*Produk:* ${product.name}\n*Varian:* ${variant.name}\n*Total stok:* ${total}\n`;

    if (total === 0) {
      return ctx.reply(header + '\n_Stok kosong._', { parse_mode: 'Markdown' });
    }

    if (total <= 20) {
      const list = stock.map((it, i) => `${i + 1}.\n${formatStockLineForView(it)}`).join('\n\n');
      await ctx.reply(header + '\n```\n' + list + '\n```', { parse_mode: 'Markdown' });
    } else {
      // Terlalu banyak untuk ditampilkan sebagai teks -> kirim sebagai file.
      await ctx.reply(header, { parse_mode: 'Markdown' });
      const fileContent = stock.map((it, i) => `${i + 1}.\n${formatStockLineForView(it)}`).join('\n\n');
      await ctx.replyWithDocument({
        source: Buffer.from(fileContent, 'utf-8'),
        filename: `stok_${variantSlug}_${Date.now()}.txt`
      });
    }
  } catch (error) {
    console.error('viewStock error:', error);
    await ctx.reply('❌ Terjadi kesalahan saat menampilkan stok.');
  }
}


module.exports = (bot) => {
  bot.command('admin', adminMiddleware, async (ctx) => {
    const {
      message, keyboard
    } = await getAdminMenuMessageAndKeyboard();
    ctx.reply(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action('admin_menu', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const {
      message, keyboard
    } = await getAdminMenuMessageAndKeyboard();
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action('admin_broadcast', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = {
      state: 'awaiting_broadcast_message'
    };
    await ctx.editMessageText(
      '🚀 *Broadcast Pesan*\n\nKirim pesan yang ingin Anda siarkan ke semua pengguna. Anda dapat menggunakan format Markdown.',
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', 'admin_menu')
        ]).reply_markup
      }
    );
  });

  bot.action('admin_profile', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const result = await getProfile();
      const data = result?.data || {};

      const msg =
      `🧾 *Profil ATL*\n\n` +
      `👤 Nama: *${data.data.name || '-'}*\n` +
      `💰 Saldo: *${data.data.balance || 0}*\n`;

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Kembali', 'admin_menu')]
        ]).reply_markup
      });

    } catch (err) {
      console.error(err);
      ctx.reply('❌ Gagal memuat profil');
    }
  });
  
bot.action('admin_tf', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();

    userStates[ctx.from.id] = {
        state: 'awaiting_transfer_data',
        step: 'format'
    };

    const message = `💳 *Buat Transfer*\n\n` +
        `Kirim data transfer dengan format:\n\n` +
        `\`kode_bank|nomor_rekening|nama_pemilik|nominal\`\n\n` +
        `*Contoh 1 (dengan ref ID):*\n` +
        `\`bca|1234567890|John Doe|50000|MYREF001\`\n\n` +
        `*Contoh 2 (tanpa ref ID):*\n` +
        `\`bni|9876543210|Jane Smith|100000\`\n\n` +
        `*Bank Populer:*\n` +
        `• **Bank Umum:** bca, bni, mandiri, bri, cimb, danamon\n` +
        `• **Bank Syariah:** bsi, muamalat, bca_syar, bni_syar\n` +
        `• **Bank Digital:** jago, jenius, seabank, bcad\n` +
        `• **E-Wallet:** gopay, ovo, shopeepay, dana, linkaja\n\n` +
        `*Minimal transfer:* Rp 10.000\n` +
        `*Maksimal transfer:* Rp 100.000.000\n` +
        `*Ref ID:* Opsional (jika kosong akan dibuat otomatis)\n\n` +
        `Setelah ini, Anda bisa tambah data opsional (email, telepon, catatan).`;

    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Batal', 'admin_menu')]
        ]).reply_markup
    });
});

bot.action('confirm_transfer_yes', adminMiddleware, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const userState = userStates[userId];
        
        if (!userState || !userState.transferData) {
            return ctx.editMessageText('❌ Data transfer tidak ditemukan. Silakan ulangi.');
        }

        const data = userState.transferData;
        
        // Generate refId otomatis jika kosong
        if (!data.refId || data.refId.trim() === '') {
            data.refId = `TF${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        }
        
        // Tampilkan status proses
        await ctx.editMessageText('🔄 *Memproses transfer...*', { 
            parse_mode: 'Markdown'
        });

        // Gunakan fungsi createTransfer yang sudah diimport
        const result = await createTransfer({
            refId: data.refId,
            kodeBank: data.kodeBank,
            nomorAkun: data.nomorAkun,
            namaPemilik: data.namaPemilik,
            nominal: data.nominal,
            email: data.email || '',
            phone: data.phone || '',
            note: data.note || ''
        });

        // Reset user state
        delete userStates[userId];

        // Tampilkan hasil
        if (result.success) {
            let successMessage = `✅ *Transfer Berhasil Dibuat*\n\n` +
                `📋 **Detail Transfer:**\n` +
                `• Ref ID: \`${data.refId}\`\n` +
                `• Bank: **${data.kodeBank.toUpperCase()}**\n` +
                `• Rekening: **${data.nomorAkun}**\n` +
                `• Penerima: **${data.namaPemilik}**\n` +
                `• Nominal: **Rp ${data.nominal.toLocaleString('id-ID')}**\n`;

            if (result.data?.id) {
                successMessage += `• ID Transfer: ${result.data.id}\n`;
            }
            if (result.data?.sn) {
                successMessage += `• SN: ${result.data.sn}\n`;
            }
            if (result.data?.status) {
                successMessage += `• Status: ${result.data.status}\n`;
            }

            await ctx.editMessageText(successMessage, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                ]).reply_markup
            });

        } else {
            await ctx.editMessageText(
                `❌ *Gagal Membuat Transfer*\n\n` +
                `**Pesan Error:** ${result.message || 'Unknown error'}\n\n` +
                `**Data yang dikirim:**\n` +
                `• Ref ID: ${data.refId}\n` +
                `• Bank: ${data.kodeBank}\n` +
                `• Rekening: ${data.nomorAkun}\n` +
                `• Penerima: ${data.namaPemilik}\n` +
                `• Nominal: Rp ${data.nominal.toLocaleString('id-ID')}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                    ]).reply_markup
                }
            );
        }

    } catch (error) {
        console.error('Transfer error:', error);
        await ctx.editMessageText(
            `❌ *Error Sistem*\n\n` +
            `${error.message}`,
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                ]).reply_markup
            }
        );
    }
});

// Handler batal konfirmasi
bot.action('confirm_transfer_no', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    delete userStates[userId];
    
    const { message, keyboard } = await adminModule.getAdminMenuMessageAndKeyboard();
    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
    });
});

  bot.action(/^admin_snk_select_product_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1]);
    const {
      message, keyboard
    } = await getProductManagementList('snk', page);
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action(/^admin_snk_product_(.+?)_page_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const product = await Product.findOne({
      id: productId
    }).lean();

    const message = `📜 *Kelola SNK untuk Produk: ${product.name}*\n\nPilih varian untuk melihat/mengubah SNK:`;
    const variantButtons = product.variants.map(v => {
      const snkStatus = (v.snk && v.snk !== '-') ? '✅': '❌';
      // Perhatikan perubahan di bawah ini: menggunakan ':' sebagai pemisah
      return [Markup.button.callback(`${snkStatus} ${v.name}`, `admin_edit_snk:${productId}:${v.slug}:${page}`)];
    });

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        ...variantButtons,
        [Markup.button.callback('⬅️ Kembali ke Daftar Produk', `admin_snk_select_product_${page}`)]
      ]).reply_markup
    });
  });

  bot.action(/^admin_edit_snk:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const page = parseInt(ctx.match[3]);

    const product = await Product.findOne({
      id: productId
    }).lean();

    // Pengecekan agar tidak crash
    if (!product) {
      return await ctx.editMessageText('❌ Produk tidak ditemukan.');
    }

    const variant = product.variants.find(v => v.slug === variantSlug);

    userStates[ctx.from.id] = {
      state: 'awaiting_snk',
      productId: productId,
      variantSlug: variantSlug,
      page: page
    };

    const currentSnk = (variant.snk && variant.snk !== '-') ? variant.snk: '_(Kosong)_';

    const message = `✍️ *Edit SNK untuk:*\n` +
    `*Produk:* ${product.name}\n` +
    `*Varian:* ${variant.name}\n\n` +
    `*SNK Saat Ini:*\n${currentSnk}\n\n` +
    `Kirimkan teks SNK yang baru. Untuk mengosongkan, kirimkan satu karakter \`-\`.`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('⬅️ Batal', `admin_snk_product_${productId}_page_${page}`)
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action(/^admin_bulk_select_product_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('bulk', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_bulk_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const product = await Product.findOne({
        id: productId
      }).lean();

      let message = `💰 *Kelola Harga Grosir: ${product.name}*\n\nPilih varian untuk mengatur harga grosir:\n\n`;
      const variantButtons = product.variants.map(v => {
        let bulkStatus = '❌';
        if (v.bulk_pricing && v.bulk_pricing.min_quantity > 0) {
          bulkStatus = `✅ min ${v.bulk_pricing.min_quantity} pcs @ ${v.bulk_pricing.price_per_item.toLocaleString('id-ID')}`;
        }
        // Perhatikan perubahan di bawah ini: menggunakan ':' sebagai pemisah
        return [Markup.button.callback(`${v.name} (${bulkStatus})`, `admin_edit_bulk:${productId}:${v.slug}:${page}`)];
      });

      await ctx.editMessageText(message,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            ...variantButtons,
            [Markup.button.callback('⬅️ Kembali ke Daftar Produk', `admin_bulk_select_product_${page}`)]
          ]).reply_markup
        });
    });

  bot.action(/^admin_edit_bulk:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const page = parseInt(ctx.match[3]);

    const product = await Product.findOne({
      id: productId
    }).lean();

    // Pengecekan penting untuk mencegah crash
    if (!product) {
      return await ctx.editMessageText('❌ Produk tidak ditemukan.');
    }

    const variant = product.variants.find(v => v.slug === variantSlug);

    userStates[ctx.from.id] = {
      state: 'awaiting_bulk_rule',
      productId: productId,
      variantSlug: variantSlug,
      page: page
    };

    let currentRule = '_(Tidak diatur)_';
    if (variant.bulk_pricing && variant.bulk_pricing.min_quantity > 0) {
      currentRule = `Minimal *${variant.bulk_pricing.min_quantity}* pcs, harga menjadi *Rp ${variant.bulk_pricing.price_per_item.toLocaleString('id-ID')}* per pcs.`;
    }

    const message = `✍️ *Atur Harga Grosir untuk:*\n` +
    `*Produk:* ${product.name}\n` +
    `*Varian:* ${variant.name}\n\n` +
    `*Aturan Saat Ini:*\n${currentRule}\n\n` +
    `Kirimkan aturan baru dengan format:\n` +
    `\`jumlah_minimum|harga_per_pcs\`\n\n` +
    `*Contoh:*\n` +
    `\`3|1000\` (artinya, pembelian min. 3 pcs harganya jadi 1000 per pcs)\n\n` +
    `Untuk menghapus aturan, kirim \`-\`.`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('⬅️ Batal', `admin_bulk_product_${productId}_page_${page}`)
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action(/^admin_add_stock_select_product_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getAddStockProductList(page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_add_stock_select_variant_(.+?)_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const {
        message,
        keyboard
      } = await getAddStockVariantList(productId, page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_add_stock_final:(.+?):(.*)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];

        const product = await Product.findOne({
          id: productId
        }).lean();

        // Pengecekan penting untuk mencegah crash
        if (!product) {
          return await ctx.editMessageText(`❌ Produk dengan ID "${productId}" tidak ditemukan.`);
        }

        const variant = product.variants.find(v => v.slug === variantSlug);

        // Pengecekan tambahan jika slug varian salah
        if (!variant) {
          return await ctx.editMessageText(`❌ Varian dengan slug "${variantSlug}" tidak ditemukan di produk ini.`);
        }

        userStates[ctx.from.id] = {
          state: 'awaiting_stock',
          productId: productId,
          variantSlug: variantSlug
        };

        const message = `✅ Anda akan menambahkan stok untuk:\n` +
        `*Produk:* ${product.name}\n` +
        `*Varian:* ${variant.name}\n\n` +
        `Silakan kirim daftar akun sekarang. Formatnya satu akun per baris, contoh:\n\n` +
        `\`email1@gmail.com|pass123\`\n` +
        `\`email2@gmail.com|pass456\`\n\n` +
        `Bot akan mengabaikan baris yang kosong.`;

        const keyboard = Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', `admin_add_stock_select_variant_${productId}_1`)
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });
      } catch(error) {
        console.error("Error in admin_add_stock_final:", error);
        // Memberikan pesan error yang lebih spesifik kepada pengguna
        await ctx.editMessageText("❌ Terjadi kesalahan internal saat memproses pilihan varian Anda.");
      }
    });

  /* ===== Ambil Stok ===== */
  bot.action(/^admin_take_stock_select_product_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1]);
    const { message, keyboard } = await getTakeStockProductList(page);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  });

  bot.action(/^admin_take_stock_select_variant_(.+?)_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const { message, keyboard } = await getTakeStockVariantList(productId, page);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  });

  bot.action(/^admin_take_stock_final:(.+?):(.*)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const variantSlug = ctx.match[2];
      const product = await Product.findOne({ id: productId }).lean();
      if (!product) return await ctx.editMessageText(`❌ Produk "${productId}" tidak ditemukan.`);
      const variant = product.variants.find(v => v.slug === variantSlug);
      if (!variant) return await ctx.editMessageText(`❌ Varian "${variantSlug}" tidak ditemukan.`);

      userStates[ctx.from.id] = { state: 'awaiting_take_stock_count', productId, variantSlug };

      const stok = Array.isArray(variant.stock) ? variant.stock.length : 0;
      const message = `➖ *Ambil Stok*\n*Produk:* ${product.name}\n*Varian:* ${variant.name}\n*Stok tersedia:* ${stok}\n\nKetik JUMLAH stok yang ingin diambil (angka):`;
      const keyboard = Markup.inlineKeyboard([Markup.button.callback('⬅️ Batal', `admin_take_stock_select_variant_${productId}_1`)]);
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (error) {
      console.error('Error in admin_take_stock_final:', error);
      await ctx.editMessageText('❌ Terjadi kesalahan internal saat memproses pilihan varian.');
    }
  });

  /* ===== Lihat Stok (view-only) ===== */
  bot.command('lihatstok', adminMiddleware, async (ctx) => {
    const { message, keyboard } = await getViewStockProductList(1);
    await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  });

  bot.action(/^admin_view_stock_select_product_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1]);
    const { message, keyboard } = await getViewStockProductList(page);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  });

  bot.action(/^admin_view_stock_select_variant_(.+?)_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const { message, keyboard } = await getViewStockVariantList(productId, page);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  });

  bot.action(/^admin_view_stock_show:(.+?):(.*)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const variantSlug = ctx.match[2];
      await viewStock(productId, variantSlug, ctx);
    } catch (error) {
      console.error('Error in admin_view_stock_show:', error);
      await ctx.reply('❌ Terjadi kesalahan internal saat menampilkan stok.');
    }
  });

  bot.action(/^admin_edit_product_list_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('edit', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  // HANDLER UNTUK KONFIRMASI PENGHAPUSAN VARIAN
  bot.action(/^admin_delete_variant_confirm:(.+?):(.+?):(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const page = parseInt(ctx.match[3]);

        const product = await Product.findOne({
          id: productId
        }).lean();

        if (!product) {
          return ctx.editMessageText(`❌ Produk dengan ID "${productId}" tidak ditemukan lagi.`);
        }

        const variant = product.variants.find(v => v.slug === variantSlug);

        if (!variant) {
          return ctx.editMessageText('❌ Varian tidak ditemukan lagi.');
        }

        const message = `⚠️ *Konfirmasi Hapus Varian*\n\n` +
        `Anda yakin ingin menghapus varian *"${variant.name}"* dari produk *"${product.name}"*?\n\n` +
        `Tindakan ini tidak dapat dibatalkan.`;

        const keyboard = Markup.inlineKeyboard([
          [
            // Perbarui juga tombol konfirmasi di sini agar polanya konsisten
            Markup.button.callback('✅ Ya, Hapus', `admin_delete_variant_execute:${productId}:${variantSlug}:${page}`),
            Markup.button.callback('❌ Batal', `admin_edit_product_${productId}_page_${page}`)
          ]
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });

      } catch (error) {
        console.error('Error confirming variant deletion:', error);
        await ctx.reply('❌ Terjadi kesalahan saat meminta konfirmasi.');
      }
    });

  // HANDLER UNTUK EKSEKUSI PENGHAPUSAN VARIAN
  bot.action(/^admin_delete_variant_execute:(.+?):(.+?):(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const page = parseInt(ctx.match[3]);

        const result = await Product.updateOne(
          {
            id: productId
          },
          {
            $pull: {
              variants: {
                slug: variantSlug
              }
            }
          }
        );

        if (result.modifiedCount > 0) {
          await ctx.editMessageText(
            '✅ Varian berhasil dihapus.',
            {
              reply_markup: Markup.inlineKeyboard([
                Markup.button.callback('⬅️ Kembali ke Edit Produk', `admin_edit_product_${productId}_page_${page}`)
              ]).reply_markup
            }
          );
        } else {
          await ctx.editMessageText('❌ Gagal menghapus varian atau varian sudah tidak ada.');
        }

      } catch (error) {
        console.error('Error executing variant deletion:', error);
        await ctx.reply('❌ Terjadi kesalahan saat menghapus varian dari database.');
      }
    });

  bot.action(/^admin_delete_product_list_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('delete', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_edit_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const {
        message,
        keyboard
      } = await getEditProductDetails(productId, page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action('admin_add_product',
    adminMiddleware,
    (ctx) => {
      ctx.editMessageText(
        'Untuk menambah produk baru, silakan kirim format berikut:\n\n`tambahproduk <id> | <nama> | <deskripsi>`\n\nContoh:\n`tambahproduk new_product | Produk Baru | Deskripsi produk baru`',
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('⬅️ Kembali Ke Menu', 'admin_menu')
          ]).reply_markup
        }
      );
    });

  bot.action(/^admin_edit_variant_(.+)_(.*)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[3]);

      const message = 'Untuk mengedit varian, silakan kirim format berikut:\n\n' +
      '`editvarian <id_produk> | <slug_varian> | <nama> | <harga>`\n\n' +
      'Contoh:\n' +
      '`editvarian spotify | 1_bulan | 1 Bulan | 20000`';

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('⬅️ Kembali', `admin_edit_product_${productId}_page_${page}`)
      ]);

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_delete_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];

        await deleteProduct(productId);

        await ctx.editMessageText(
          '✅ Produk berhasil dihapus!',
          {
            reply_markup: Markup.inlineKeyboard([
              Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')
            ]).reply_markup
          }
        );
      } catch (error) {
        console.error('Error deleting product:', error);
        await ctx.reply('❌ Terjadi kesalahan saat menghapus produk. Mohon coba lagi nanti.');
      }
    });

  bot.action(/^admin_edit_name_desc_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);

      try {
        const product = await Product.findOne({
          id: productId
        }).lean();

        userStates[ctx.from.id] = {
          state: 'edit_product_name_desc',
          productId: productId,
          page: page
        };

        const message = `✍️ *Edit Nama & Deskripsi Produk:* ${product.name}\n\n` +
        `Silakan kirim nama dan deskripsi baru dalam format:\n\n` +
        `\`<Nama Baru> | <Deskripsi Baru>\`\n\n` +
        `Contoh:\n` +
        `\`CAPCUT Pro NEW | Versi terbaru.\``;

        const keyboard = Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', `admin_edit_product_${productId}_page_${page}`)
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        console.error('Error in admin_edit_name_desc:', error);
        await ctx.editMessageText('❌ Produk tidak ditemukan.');
      }
    });

  bot.action(/^admin_add_variant_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);

      userStates[ctx.from.id] = {
        state: 'add_new_variant',
        productId: productId,
        page: page
      };

      const message = `➕ *Tambah Varian Baru*\n\n` +
      `Silakan kirim detailnya dalam format berikut:\n\n` +
      `\`<Nama Varian> | <Harga> | <Slug Varian>\`\n\n` +
      `*Contoh:*\n` +
      `\`1 Bulan | 15000 | 1_bulan\``;

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('⬅️ Batal', `admin_edit_product_${productId}_page_${page}`)
      ]);

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });
};

module.exports.getAdminMenuMessageAndKeyboard = getAdminMenuMessageAndKeyboard;
module.exports.addStock = addStock;
module.exports.takeStock = takeStock;
module.exports.userStates = userStates;
module.exports.adminMiddleware = adminMiddleware;