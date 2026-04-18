const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Ganti dengan ID grup tujuan (semua hasil monitoring akan dikirim ke sini)
const TARGET_GROUP_ID = '120363425042480341@g.us'; // <-- Ganti dengan ID grup tujuan
// const TARGET_GROUP_ID = '120363425672105653@g.us'; // <-- Ganti dengan ID grup tujuan
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

const ENABLE_METADATA_SCAN = true; // Ubah ke false jika ingin nonaktifkan fitur baca metadata grup/saluran

// const userCount = parseInt(process.env.USER || process.env.USER_COUNT || '2', 10) || 1; // isi_banyaknya_user
const userCount = parseInt(process.env.USER_COUNT, 10) || 3;
const forwardedSet = new Set();
const processingSet = new Set();
// const forwardedSet = new Map();
const SESSION_PATH = path.join(__dirname, 'wa_sessions');
const QR_IMAGE_DIR = path.join(__dirname, 'qr_codes');
if (!fs.existsSync(SESSION_PATH)) {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
}
if (!fs.existsSync(QR_IMAGE_DIR)) {
    fs.mkdirSync(QR_IMAGE_DIR, { recursive: true });
}

async function saveQrForClient(index, qr) {
    const botName = `bot${index + 1}`;
    const htmlPath = path.join(QR_IMAGE_DIR, `${botName}.html`);
    const textPath = path.join(QR_IMAGE_DIR, `${botName}.txt`);
    const pngPath = path.join(QR_IMAGE_DIR, `${botName}.png`);
    const remoteQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    let pngSaved = false;

    try {
        const QR = require('qrcode');
        await QR.toFile(pngPath, qr, { width: 400 });
        pngSaved = true;
    } catch {
        pngSaved = false;
    }

    const htmlContent = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WhatsApp QR Bot ${botName}</title>
<style>body{font-family:Arial,sans-serif;text-align:center;padding:24px;}img{max-width:100%;height:auto;border:1px solid #ddd;padding:12px;border-radius:8px;}code{display:block;margin-top:16px;white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:10px;border-radius:6px;text-align:left;}</style>
</head>
<body>
<h1>QR untuk ${botName}</h1>
<p>Scan QR ini menggunakan WhatsApp Anda. Jika Anda perlu screenshot jarak jauh, buka berkas ini di browser.</p>
<img src="${pngSaved ? path.basename(pngPath) : remoteQrUrl}" alt="QR Code for ${botName}" />
<code>${qr}</code>
</body>
</html>`;

    fs.writeFileSync(textPath, qr, 'utf8');
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');

    return {
        htmlPath,
        textPath,
        pngPath: pngSaved ? pngPath : null,
        remoteQrUrl
    };
}

function createClientInstance(index) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `bot${index + 1}`,
            dataPath: SESSION_PATH
        }),
        // TAMBAHKAN BAGIAN INI:
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // <- Sangat membantu untuk memori di cloud
                '--disable-gpu'
            ]
        }
    });

    client.chatLastDesc = new Map();

    let lastQr = null;
    client.on('qr', async (qr) => {
        if (qr === lastQr) {
            console.log(`QR bot #${index + 1} tidak berubah, gunakan kembali berkas QR yang sama.`);
            return;
        }
        lastQr = qr;

        qrcode.generate(qr, { small: true });
        const paths = await saveQrForClient(index, qr);
        console.log(`Scan QR code untuk bot #${index + 1} dengan WhatsApp kamu!`);
        console.log(`Buka file untuk screenshot jarak jauh: ${paths.htmlPath}`);
        if (paths.pngPath) {
            console.log(`File PNG QR disimpan di: ${paths.pngPath}`);
        } else {
            console.log(`Jika QR tidak dapat dibuat secara lokal, gunakan URL ini di browser: ${paths.remoteQrUrl}`);
        }
        console.log(`Sesi akan disimpan di: ${path.join(SESSION_PATH, `bot${index + 1}`)}`);
    });

    client.on('authenticated', () => {
        console.log(`Bot WhatsApp #${index + 1} sudah terautentikasi, sesi disimpan.`);
    });

    client.on('ready', () => {
        console.log(`Bot WhatsApp #${index + 1} siap dan terhubung!`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`Autentikasi bot #${index + 1} gagal:`, msg);
    });

    return client;
}

const clients = Array.from({ length: userCount }, (_, i) => createClientInstance(i));

// Helper: Decode QR from a Jimp image bitmap
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

// Helper: Deteksi QR dari buffer gambar
async function detectQR(buffer) {
    try {
        const normalized = await normalizeImageForOCR(buffer);
        const image = await Jimp.read(normalized);

        // Try original image first
        let result = await decodeQrFromImage(image);
        if (result) return result;

        // Try some preprocessing variants
        const variants = [
            image.clone().greyscale().contrast(0.3).threshold({ max: 128 }),
            image.clone().greyscale().contrast(0.5).threshold({ max: 128 }),
            image.clone().resize(image.bitmap.width * 0.8, Jimp.AUTO).greyscale().contrast(0.4).threshold({ max: 128 })
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

// Helper: Convert image to PNG when needed so Tesseract can read WebP/sticker files
async function normalizeImageForOCR(buffer) {
    try {
        const image = await Jimp.read(buffer);
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch {
        try {
            return await sharp(buffer).png().toBuffer();
        } catch {
            return buffer;
        }
    }
}

// Helper: OCR dari buffer gambar
async function detectText(buffer) {
    try {
        const normalized = await normalizeImageForOCR(buffer);
        const { data: { text } } = await Tesseract.recognize(normalized, 'eng');
        return text.toLowerCase();
    } catch {
        return '';
    }
}

function extractUrls(text) {
    if (!text) return [];
    // Improved regex: catch http(s), www, direct domains
    // const urls = text.match(/(https?:\/\/)?(?:www\.)?(dana\.id|gopay\.co\.id|shopeepay\.co\.id)(?:\/[^\\s]*)?/gi) || [];
    const urls = text.match(/(https?:\/\/)?(?:[\w-]+\.)?(dana\.id|gopay\.co\.id|shopeepay\.co\.id)(?:\/[^\s]*)?/gi) || [];
    return urls.map(url => {
        // Normalize: add https:// if missing
        if (!url.startsWith('http')) {
            return 'https://' + url;
        }
        return url;
    }).filter(Boolean);
}
// function extractUrls(text) {
//     if (!text) return [];

//     const regex = /(https?:\/\/)?(?:[\w-]+\.)?(dana\.id|gopay\.co\.id|shopeepay\.co\.id)(\/[^\s]*)?/gi;

//     const matches = text.match(regex) || [];

//     return matches.map(url => {
//         if (!url.startsWith('http')) {
//             return 'https://' + url;
//         }
//         return url;
//     });
// }

function getChatMetadataText(chat) {
    if (!chat || typeof chat !== 'object') return '';

    const fields = [
        chat.description || '',
        chat.about || '',
        chat.topic || '',
        chat.name || '',
        chat.subject || '',
        chat.title || '',
        chat.banner || ''
    ];

    return fields.filter(Boolean).join('\n');
}

function getChatType(chat) {
    if (!chat) return 'Chat';

    if (chat.isGroup) return 'Grup';

    if (
        chat.isChannel ||
        chat?.id?.server === 'newsletter'
    ) {
        return 'Saluran';
    }

    if (chat.isBroadcast) return 'Broadcast';

    return 'Chat';
}

function getChatMetadataLabel(chat) {
    if (!chat) return 'Metadata Chat';
    if (chat.isGroup) return 'Deskripsi Grup';
    if (chat.isBroadcast) return 'Metadata Broadcast';
    if (chat.isChannel) return 'Deskripsi Saluran';
    return 'Metadata Chat';
}

function containsPotentialTarget(text) {
    if (!text) return false;

    const lower = text.toLowerCase();

    return (
        lower.includes('dana') ||
        lower.includes('gopay') ||
        lower.includes('shopeepay') ||
        lower.includes('dana.id') ||
        lower.includes('gopay.co.id') ||
        lower.includes('shopeepay.co.id')
    );
}


async function scanTextForLinks(client, text, label) {

    if (!containsPotentialTarget(text)) return;

    const urls = extractUrls(text);

    if (!urls.length) return;

    for (const url of urls) {

        if (VALID_DOMAINS.test(url)) {

            await sendOnce(
                client,
                url,
                label
            );
        }
    }
}

async function sendOnce(client, text, label) {

    const normalizedKey =
        text.trim().toLowerCase();

    if (forwardedSet.has(normalizedKey)) {
        return false;
    }

    if (processingSet.has(normalizedKey)) {
        return false;
    }

    try {

        processingSet.add(normalizedKey);

        await client.sendMessage(
            TARGET_GROUP_ID,
            `${text}\n\nTipe: ${label}`,
            { linkPreview: false }
        );

        forwardedSet.add(normalizedKey);

        console.log(
            `[BERHASIL] ${label}: ${text}`
        );

        return true;

    } catch (err) {

        console.error(
            `[GAGAL FORWARD] ${err.message}`
        );

        return false;

    } finally {

        processingSet.delete(normalizedKey);
    }
}

function getMessageSource(msg) {
    return msg.from || (msg.id && msg.id.remote) || msg.to || '';
}

function isAllowedSource(source) {
    if (!source) return false;
    if (source === TARGET_GROUP_ID) return false;
    // Terima semua sumber WA yang memakai ID dengan @,
    // termasuk grup, chat pribadi, broadcast, channel, dan saluran baru.
    return source.includes('@');
}

async function handleMessage(client, msg) {
    const source = getMessageSource(msg);
    if (!isAllowedSource(source)) return;

    // 1. Deteksi link pada pesan teks
    if (msg.body) {
        let label = 'Link';

        try {
            const chat = await msg.getChat();

            if (chat) {
                if (chat.isGroup) {
                    label = 'Link';
                }
                else if (
                    chat.isChannel ||
                    chat?.id?.server === 'newsletter'
                ) {
                    label = 'Link';
                }
            }

        } catch { }

        await scanTextForLinks(client, msg.body, label);
    }
    // 2. Deteksi QR/OCR pada gambar (kecuali stiker)
    if (
        msg.hasMedia &&
        msg.type !== 'sticker'
    ) {
        try {

            const media =
                await msg.downloadMedia();

            if (!media || !media.data) return;

            if (
                media.mimetype &&
                media.mimetype.startsWith('image')
            ) {
                const buffer =
                    Buffer.from(
                        media.data,
                        'base64'
                    );

                const qrData =
                    await detectQR(buffer);

                if (
                    qrData &&
                    VALID_DOMAINS.test(qrData)
                ) {
                    await sendOnce(
                        client,
                        qrData,
                        'Gambar QR'
                    );
                }
            }

        } catch (err) {
            // silent
        }
    }

    // 3. Deteksi QR pada stiker
    if (msg.type === 'sticker' && msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data && media.mimetype && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const qrData = await detectQR(buffer);
                if (qrData && VALID_DOMAINS.test(qrData)) {
                    await sendOnce(client, qrData, 'Stiker QR');
                }
            }
        } catch (err) {
            console.warn(`Gagal download media stiker: ${err.message || err}`);
        }
    }
}

clients.forEach(client => {

    // DETEKSI SAAT DESKRIPSI GROUP DIUBAH
    client.on('group_update', async (notification) => {
        try {
            const chat = await notification.getChat();

            if (!chat) return;

            const chatId = chat.id._serialized;

            const currentDesc = chat.description || '';

            const lastDesc = client.chatLastDesc.get(chatId) || '';

            if (!client.chatLastDesc.has(chatId)) {
                client.chatLastDesc.set(chatId, currentDesc);
                return;
            }

            if (currentDesc !== lastDesc) {

                client.chatLastDesc.set(chatId, currentDesc);

                await scanTextForLinks(
                    client,
                    currentDesc,
                    'Deskripsi Grup'
                );
            }

        } catch (err) {
            // silent
        }
    });

    client.on('message', async msg => {

        if (ENABLE_METADATA_SCAN && typeof msg.getChat === 'function') {
            try {

                const chat = await msg.getChat();

                if (!chat) return;

                const isGroup =
                    chat.isGroup;

                const isChannel =
                    chat.isChannel ||
                    chat?.id?.server === 'newsletter';

                if (isGroup || isChannel) {

                    const chatId = chat.id._serialized;

                    const currentDesc =
                        getChatMetadataText(chat);

                    const lastDesc =
                        client.chatLastDesc.get(chatId) || '';

                    if (!client.chatLastDesc.has(chatId)) {
                        client.chatLastDesc.set(chatId, currentDesc);
                    }

                    else if (currentDesc !== lastDesc) {

                        client.chatLastDesc.set(chatId, currentDesc);

                        await scanTextForLinks(
                            client,
                            currentDesc,
                            getChatType(chat)
                        );
                    }
                }

            } catch (err) {
                // silent
            }
        }

        await handleMessage(client, msg);

    });

    client.initialize();
});