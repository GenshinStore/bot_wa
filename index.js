const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const fs = require('fs');
const path = require('path');

// Ganti dengan ID grup tujuan
const TARGET_GROUP_ID = '120363425042480341@g.us'; 
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

const userCount = parseInt(process.env.USER_COUNT, 10) || 2;
const forwardedSet = new Set();
const processingSet = new Set();

// Hanya perlu folder session, tidak perlu folder qr_image
const SESSION_PATH = path.join(__dirname, 'wa_sessions');
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

function getMessageSource(msg) {
    return msg.from || (msg.id && msg.id.remote) || msg.to || '';
}

function isAllowedSource(source) {
    if (!source) return false;
    if (source === TARGET_GROUP_ID) return false;
    
    // Semua sumber diizinkan (Grup, Pribadi, dan Channel/Saluran)
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
        if (sourceId) {
            message += `\nSumber: ${sourceId}`;
        }

        await client.sendMessage(TARGET_GROUP_ID, message, { linkPreview: false });
        forwardedSet.add(normalizedKey);

        console.log(`[BERHASIL] ${label}: ${text}`);
        return true;
    } catch (err) {
        console.error(`[GAGAL FORWARD] ${err.message}`);
        return false;
    } finally {
        processingSet.delete(normalizedKey);
        
        // Membersihkan cache agar RAM server tidak penuh jika jalan berbulan-bulan
        if (forwardedSet.size > 5000) {
            const firstItem = forwardedSet.keys().next().value;
            forwardedSet.delete(firstItem);
        }
    }
}

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

    // 1. Deteksi link pada pesan teks (Termasuk dari Saluran/Channel)
    if (msg.body) {
        await scanTextForLinks(client, msg.body, 'Link', source);
    }

    // 2. Deteksi QR pada Gambar
    if (msg.hasMedia && msg.type !== 'sticker') {
        try {
            const media = await msg.downloadMedia();
            if (!media || !media.data) return;

            if (media.mimetype && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const image = await Jimp.read(buffer);
                const qr = new QrCode();

                qr.callback = async (err, value) => {
                    if (!err && value && VALID_DOMAINS.test(value.result)) {
                        await sendOnce(client, value.result, 'Gambar QR', source);
                    }
                };
                qr.decode(image.bitmap);
            }
        } catch (err) { }
    }

    // 3. Deteksi QR pada Stiker
    if (msg.type === 'sticker' && msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const image = await Jimp.read(buffer);
                const qr = new QrCode();

                qr.callback = async (err, value) => {
                    if (!err && value && VALID_DOMAINS.test(value.result)) {
                        await sendOnce(client, value.result, 'Stiker QR', source);
                    }
                };
                qr.decode(image.bitmap);
            }
        } catch (err) { }
    }
}

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

    // ======= BAGIAN QR YANG SUDAH DIPERBAIKI =======
    client.on('qr', (qr) => {
        console.log(`\n======================================================`);
        console.log(`🟢 ADA QR BARU UNTUK BOT ${index + 1}`);
        console.log(`Klik atau Copy-Paste link di bawah ini ke browser Anda:`);
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
        console.log(`======================================================\n`);
    });

    client.on('ready', () => {
        console.log(`✅ Bot ${index + 1} siap dan terhubung!`);
    });

    client.on('message', async msg => {
        try {
            await handleMessage(client, msg);
        } catch (err) {
            // Error dari channel biasanya muncul di sini, tapi bot tidak akan mati
            // console.log('Error aman:', err.message);
        }
    });

    return client;
}

const clients = Array.from({ length: userCount }, (_, i) => createClientInstance(i));
clients.forEach(client => client.initialize());