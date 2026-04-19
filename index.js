const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Ganti dengan ID grup tujuan
const TARGET_GROUP_ID = '120363425042480341@g.us';
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

const userCount = parseInt(process.env.USER_COUNT, 10) || 2;
const forwardedSet = new Set();
const processingSet = new Set();

const SESSION_PATH = path.join(__dirname, 'wa_sessions');
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

function getMessageSource(msg) {
    return msg.from || (msg.id && msg.id.remote) || msg.to || '';
}

function isAllowedSource(source) {
    if (!source) return false;
    if (source === TARGET_GROUP_ID) return false;
    return source.includes('@');
}

function extractUrls(text) {
    if (!text) return [];
    const urls = text.match(/(https?:\/\/)?(?:[\w-]+\.)?(dana\.id|gopay\.co\.id|shopeepay\.co\.id)(?:\/[^\s]*)?/gi) || [];
    return urls.map(url => {
        if (!url.startsWith('http')) return 'https://' + url;
        return url;
    }).filter(Boolean);
}

function containsPotentialTarget(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return (
        lower.includes('dana') || lower.includes('gopay') || lower.includes('shopeepay') ||
        lower.includes('dana.id') || lower.includes('gopay.co.id') || lower.includes('shopeepay.co.id')
    );
}

async function sendOnce(client, text, label, sourceId = null) {
    const normalizedKey = text.trim().toLowerCase();

    if (forwardedSet.has(normalizedKey)) return false;
    if (processingSet.has(normalizedKey)) return false;

    try {
        processingSet.add(normalizedKey);

        let message = `${text}\n\nTipe: ${label}`;

        await client.sendMessage(TARGET_GROUP_ID, message, { linkPreview: false });
        forwardedSet.add(normalizedKey);

        console.log(`[BERHASIL] ${label}: ${text}`);
        return true;
    } catch (err) {
        console.error(`[GAGAL FORWARD] ${err.message}`);
        return false;
    } finally {
        processingSet.delete(normalizedKey);
        if (forwardedSet.size > 5000) {
            const firstItem = forwardedSet.keys().next().value;
            forwardedSet.delete(firstItem);
        }
    }
}

// ============================================================================
// FUNGSI PEMBACA QR KHUSUS STIKER & GAMBAR 
// ============================================================================
async function normalizeImageForOCR(buffer) {
    try {
        return await sharp(buffer)
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .png()
            .toBuffer();
    } catch (err) {
        return buffer;
    }
}

function decodeQrFromImage(image) {
    return new Promise((resolve) => {
        const qr = new QrCode();
        qr.callback = (err, value) => {
            if (err || !value) return resolve(null);
            resolve(value.result);
        };
        qr.decode(image.bitmap);
    });
}

async function detectQR(buffer) {
    try {
        const normalized = await normalizeImageForOCR(buffer);
        const image = await Jimp.read(normalized);

        let result = await decodeQrFromImage(image);
        if (result) return result;

        const variants = [
            image.clone().greyscale().contrast(0.5).threshold({ max: 128 }),
            image.clone().resize(image.bitmap.width * 0.8, Jimp.AUTO).greyscale().contrast(0.4)
        ];

        for (const variant of variants) {
            result = await decodeQrFromImage(variant);
            if (result) return result;
        }
        return null;
    } catch {
        return null;
    }
}
// ============================================================================

async function scanTextForLinks(client, text, label, sourceId = null) {
    if (!containsPotentialTarget(text)) return;
    const urls = extractUrls(text);
    if (!urls.length) return;

    for (const url of urls) {
        if (VALID_DOMAINS.test(url)) {
            await sendOnce(client, url, label, sourceId);
        }
    }
}

async function handleMessage(client, msg) {
    const source = getMessageSource(msg);
    if (!isAllowedSource(source)) return;

    if (msg.body) {
        await scanTextForLinks(client, msg.body, 'Link', source);
    }

    if (msg.hasMedia && msg.type !== 'sticker') {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data && media.mimetype && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const qrData = await detectQR(buffer);

                if (qrData && VALID_DOMAINS.test(qrData)) {
                    await sendOnce(client, qrData, 'Gambar QR', source);
                }
            }
        } catch (err) { }
    }

    if (msg.type === 'sticker' && msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data && media.mimetype && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const qrData = await detectQR(buffer);

                if (qrData && VALID_DOMAINS.test(qrData)) {
                    await sendOnce(client, qrData, 'Stiker QR', source);
                }
            }
        } catch (err) { }
    }
}

// Fungsi Bantuan untuk menampilkan link QR di Terminal (Fallback)
function printQrToConsole(index, qr) {
    console.log(`\n======================================================`);
    console.log(`🟢 ADA QR BARU UNTUK BOT ${index + 1}`);
    console.log(`Klik atau Copy-Paste link di bawah ini ke browser Anda:`);
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
    console.log(`======================================================\n`);
}

// Deklarasi array clients di luar agar bisa diakses antar bot
const clients = [];

function createClientInstance(index) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `bot${index + 1}`,
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        }
    });

    client.chatLastDesc = new Map();

    // Tanda pengenal apakah bot ini sudah sukses login
    client.isReady = false;

    // ============================================================================
    // SISTEM PENGIRIMAN QR CODE PINTAR (VERSI ANTI GAGAL)
    // ============================================================================
    client.on('qr', async (qr) => {
        // Cari apakah ada bot lain yang sudah "Ready" di dalam array clients
        const readyClient = clients.find(c => c.isReady);
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;

        if (readyClient) {
            console.log(`🔄 Meminjam Bot Aktif untuk mengirim Notifikasi QR Bot ${index + 1} ke Grup...`);
            try {
                // SOLUSI: Kirim pesan teks berisi link. Sangat ringan dan lolos blokir!
                const pesan = `🟢 *PERMINTAAN LOGIN BOT ${index + 1}*\n\nBot ini membutuhkan akses. Silakan klik link di bawah ini untuk menampilkan QR Code Anda:\n\n🔗 ${qrUrl}\n\n_(Pesan ini akan otomatis terkirim ulang setiap 20 detik selama belum di-scan)_`;

                // linkPreview: true agar WA berusaha memunculkan gambar kotaknya secara otomatis
                await readyClient.sendMessage(TARGET_GROUP_ID, pesan, { linkPreview: true });
                console.log(`✅ Link QR Bot ${index + 1} berhasil dikirim ke Grup.`);
            } catch (err) {
                console.log(`⚠️ Gagal mengirim QR ke grup karena error: ${err.message}`);
                printQrToConsole(index, qr);
            }
        } else {
            // Jika belum ada satu pun bot yang terhubung
            printQrToConsole(index, qr);
        }
    });
    // ============================================================================

    client.on('ready', () => {
        client.isReady = true; // Tandai bot siap bekerja!
        console.log(`✅ Bot ${index + 1} siap dan terhubung!`);
    });

    client.on('disconnected', () => {
        client.isReady = false; // Copot tanda jika terputus
    });
    // ============================================================================

    client.on('group_update', async (notification) => {
        try {
            if (notification.type === 'description') {
                const chat = await notification.getChat();
                if (!chat) return;

                const chatId = chat.id._serialized;
                const newDescription = notification.body || chat.description || '';

                if (newDescription) {
                    await scanTextForLinks(
                        client,
                        newDescription,
                        'Deskripsi Grup',
                        chatId
                    );
                }
            }
        } catch (err) { }
    });

    client.on('message', async msg => {
        try {
            const currentTimestamp = Math.floor(Date.now() / 1000);
            if (msg.timestamp < currentTimestamp - 60) {
                return;
            }
            await handleMessage(client, msg);
        } catch (err) { }
    });

    return client;
}

// Inisialisasi bot dan masukkan ke array secara berurutan
for (let i = 0; i < userCount; i++) {
    clients.push(createClientInstance(i));
}

// Jalankan semua bot
clients.forEach(client => client.initialize());

// ============================================================================
// SISTEM AUTO-RESTART PADA WAKTU SPESIFIK (12 MALAM & 6 PAGI)
// ============================================================================
setInterval(() => {
    const sekarang = new Date();
    const waktuLokal = sekarang.toLocaleString("en-US", { timeZone: "Asia/Jakarta" });
    const jamLokal = new Date(waktuLokal).getHours();
    const minitLokal = new Date(waktuLokal).getMinutes();

    if ((jamLokal === 0 && minitLokal === 0) || (jamLokal === 6 && minitLokal === 0)) {
        console.log(`⏳ Waktu Restart Tiba (${jamLokal}:00). Memulakan semula sistem...`);
        process.exit(1);
    }
}, 60000);

process.on('unhandledRejection', error => {
    console.error('⚠️ Error tidak terjangka:', error.message);
});

process.on('uncaughtException', error => {
    console.error('⚠️ Sistem crash:', error.message);
});
// ============================================================================