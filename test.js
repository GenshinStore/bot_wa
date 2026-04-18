const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// const TARGET_GROUP_ID = '120363425672105653@g.us';
const TARGET_GROUP_ID = '120363425042480341@g.us';
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

const ENABLE_METADATA_SCAN = true;

const userCount = parseInt(process.env.USER || process.env.USER_COUNT || '2', 10) || 1;
const forwardedSet = new Set();
const processingSet = new Set();

const SESSION_PATH = path.join(__dirname, 'wa_sessions');
const QR_IMAGE_DIR = path.join(__dirname, 'qr_codes');

if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(QR_IMAGE_DIR)) fs.mkdirSync(QR_IMAGE_DIR, { recursive: true });

function getMessageSource(msg) {
    return msg.from || (msg.id && msg.id.remote) || msg.to || '';
}

function isAllowedSource(source) {
    if (!source) return false;
    if (source === TARGET_GROUP_ID) return false;

    // ❗ skip channel biar tidak error
    if (source.includes('@newsletter')) return false;

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
        lower.includes('dana') ||
        lower.includes('gopay') ||
        lower.includes('shopeepay') ||
        lower.includes('dana.id') ||
        lower.includes('gopay.co.id') ||
        lower.includes('shopeepay.co.id')
    );
}

// ✅ FIX: tambah sourceId
async function scanTextForLinks(client, text, label, sourceId = null) {

    if (!containsPotentialTarget(text)) return;

    const urls = extractUrls(text);
    if (!urls.length) return;

    for (const url of urls) {
        if (VALID_DOMAINS.test(url)) {

            await sendOnce(
                client,
                url,
                label,
                sourceId // ⬅️ tambahan
            );
        }
    }
}

// ✅ FIX: tambah sourceId (opsional)
async function sendOnce(client, text, label, sourceId = null) {

    const normalizedKey = text.trim().toLowerCase();

    if (forwardedSet.has(normalizedKey)) return false;
    if (processingSet.has(normalizedKey)) return false;

    try {

        processingSet.add(normalizedKey);

        let message = `${text}\n\nTipe: ${label}`;

        // ➕ hanya tampilkan sumber jika ada
        if (sourceId) {
            message += `\nSumber: ${sourceId}`;
        }

        await client.sendMessage(
            TARGET_GROUP_ID,
            message,
            { linkPreview: false }
        );

        forwardedSet.add(normalizedKey);

        console.log(`[BERHASIL] ${label}: ${text}`);

        return true;

    } catch (err) {

        console.error(`[GAGAL FORWARD] ${err.message}`);
        return false;

    } finally {
        processingSet.delete(normalizedKey);
    }
}

// ================= HANDLE MESSAGE =================
async function handleMessage(client, msg) {

    const source = getMessageSource(msg);

    if (!isAllowedSource(source)) return;

    // ✅ KHUSUS LINK → kirim sumber
    if (msg.body) {
        await scanTextForLinks(
            client,
            msg.body,
            'Link',
            source // ⬅️ sumber dikirim
        );
    }

    // ================= QR (TIDAK DIUBAH) =================
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
                        await sendOnce(client, value.result, 'Gambar QR');
                    }
                };

                qr.decode(image.bitmap);
            }

        } catch {}
    }

    // ================= STIKER =================
    if (msg.type === 'sticker' && msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();

            if (media && media.data && media.mimetype.startsWith('image')) {
                const buffer = Buffer.from(media.data, 'base64');
                const image = await Jimp.read(buffer);

                const qr = new QrCode();

                qr.callback = async (err, value) => {
                    if (!err && value && VALID_DOMAINS.test(value.result)) {
                        await sendOnce(client, value.result, 'Stiker QR');
                    }
                };

                qr.decode(image.bitmap);
            }

        } catch {}
    }
}

// ================= CLIENT =================
function createClientInstance(index) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `bot${index + 1}`,
            dataPath: SESSION_PATH
        })
    });

    client.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        console.log(`Scan QR bot ${index + 1}`);
    });

    client.on('ready', () => {
        console.log(`Bot ${index + 1} siap`);
    });

    // ✅ GABUNGKAN MESSAGE (biar tidak double)
    client.on('message', async msg => {
        try {
            await handleMessage(client, msg);

            // log ID grup
            const source = getMessageSource(msg);
            if (source.endsWith('@g.us')) {
                console.log('ID Grup:', source);
            }

        } catch (err) {
            console.log('Error aman:', err.message);
        }
    });
    client.on('message', async msg => {
    console.log('MASUK PESAN:', msg.body);

    try {
        await handleMessage(client, msg);
    } catch (err) {
        console.log('Error:', err.message);
    }
    });

    return client;
}

const clients = Array.from({ length: userCount }, (_, i) => createClientInstance(i));
clients.forEach(client => client.initialize());