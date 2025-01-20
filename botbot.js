// index.js
const TelegramBot = require('node-telegram-bot-api');
const { 
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const { promisify } = require('util');

// Bot Configuration
const token = '7711523807:AAFu5Qn6rBWZ5JPHWdM_afApyNsaieIAHDQ';
const bot = new TelegramBot(token, { polling: true });

// Authorized Users
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Store Management
const sessions = new Map();
const qrMessages = new Map();
const userStates = new Map();

// Helper function to get group invite link
async function getGroupInviteLink(sock, jid) {
    try {
        const groupMetadata = await sock.groupMetadata(jid);
        const botNumber = sock.user.id;
        const isAdmin = groupMetadata.participants.some(
            p => p.id === botNumber && (p.admin === 'admin' || p.admin === 'superadmin')
        );

        if (!isAdmin) {
            throw new Error('Bot bukan admin di grup ini');
        }

        const inviteCode = await sock.groupInviteCode(jid);
        return `https://chat.whatsapp.com/${inviteCode}`;
    } catch (error) {
        console.error('Error getting group link:', error);
        throw error;
    }
}

// Authorization Check
async function checkAuthorization(userId, msg) {
    if (!AUTHORIZED_USERS.includes(userId)) {
        await bot.sendMessage(msg.chat.id, '⛔ Access Denied.\n\nYou are not authorized to use this bot.');
        return false;
    }
    return true;
}

// WhatsApp Connection Handler
async function connectToWhatsApp(userId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('Hiyaok Create');
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            logger: pino({ level: 'silent' }),
            msgRetryCounterMap: {},
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            emitOwnEvents: true
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrImage = await QRCode.toBuffer(qr);
                    
                    if (qrMessages.has(userId)) {
                        try {
                            await bot.deleteMessage(userId, qrMessages.get(userId));
                        } catch (err) {
                            console.log('Previous QR deletion error:', err);
                        }
                    }

                    const msg = await bot.sendPhoto(userId, qrImage, {
                        caption: '📱 *WhatsApp QR Code*\n\n' +
                                '1️⃣ Buka WhatsApp di HP Anda\n' +
                                '2️⃣ Ketuk Menu/Settings dan pilih *WhatsApp Web*\n' +
                                '3️⃣ Arahkan kamera HP ke QR code ini\n\n' +
                                '⚠️ QR code akan expired dalam 30 detik',
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '❌ Batalkan Koneksi', callback_data: 'cancel_login' }
                            ]]
                        }
                    });
                    
                    qrMessages.set(userId, msg.message_id);
                } catch (err) {
                    console.error('QR generation error:', err);
                    await bot.sendMessage(userId, '❌ Error generating QR code. Please try again.');
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? 
                    lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
                
                if (shouldReconnect) {
                    await bot.sendMessage(userId, '🔄 Menghubungkan ulang ke WhatsApp...\n\nMohon tunggu...');
                    connectToWhatsApp(userId);
                } else {
                    await bot.sendMessage(userId, '📴 Sesi WhatsApp telah logout', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Hubungkan Kembali', callback_data: 'connect' }
                            ]]
                        }
                    });
                    sessions.delete(userId);
                    await clearSession(userId);
                }
            }

            if (connection === 'open') {
                sessions.set(userId, sock);
                
                if (qrMessages.has(userId)) {
                    try {
                        await bot.deleteMessage(userId, qrMessages.get(userId));
                        qrMessages.delete(userId);
                    } catch (err) {
                        console.log('QR message deletion error:', err);
                    }
                }

                await bot.sendMessage(userId, '✅ *WhatsApp Berhasil Terhubung!*\n\n' +
                    'Pilih tindakan dari menu di bawah:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Buat Grup Baru', callback_data: 'create_group' },
                            { text: '🚪 Logout', callback_data: 'logout' }
                        ]]
                    }
                });
            }
        });

        sock.ev.on('creds.update', saveCreds);
        return sock;
    } catch (error) {
        console.error('Connection error:', error);
        await bot.sendMessage(userId, '❌ Gagal terhubung ke WhatsApp. Silakan coba lagi.');
        return null;
    }
}

// Parse VCF content
function parseVCF(content) {
    const contacts = [];
    const lines = content.split('\n');
    let currentNumber = null;
    
    for (let line of lines) {
        line = line.trim();
        
        if (line.startsWith('TEL;') || line.startsWith('TEL:')) {
            let number = line.split(':')[1];
            if (number) {
                number = number.replace(/[^0-9]/g, '');
                
                if (number.startsWith('62')) {
                    number = number;
                } else if (number.startsWith('+62')) {
                    number = number.substring(1);
                } else if (number.startsWith('0')) {
                    number = '62' + number.substring(1);
                } else if (!number.startsWith('62')) {
                    number = '62' + number;
                }
                
                if (number.length >= 12) {
                    const waNumber = number + '@s.whatsapp.net';
                    if (!contacts.includes(waNumber)) {
                        contacts.push(waNumber);
                    }
                }
            }
        }
    }
    
    return contacts;
}

// Clear session data
async function clearSession(userId) {
    try {
        const sessionPath = 'Hiyaok Create';
        await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (error) {
        console.error('Session clearing error:', error);
    }
}

// Command Handlers
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    await bot.sendMessage(userId, '👋 *Selamat datang di WhatsApp Group Manager!*\n\n' +
        'Bot ini membantu Anda membuat grup WhatsApp dari file kontak VCF.\n\n' +
        'Pilih opsi untuk memulai:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '🔄 Hubungkan WhatsApp', callback_data: 'connect' }
            ]]
        }
    });
});

// Get group links command
bot.onText(/\/getlink/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    const sock = sessions.get(userId);
    if (!sock) {
        await bot.sendMessage(userId, '❌ WhatsApp belum terkoneksi!\n\nSilakan koneksikan terlebih dahulu.', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Koneksikan WhatsApp', callback_data: 'connect' }
                ]]
            }
        });
        return;
    }

    try {
        const statusMsg = await bot.sendMessage(userId, '🔍 Mengambil link grup...');
        
        const groups = await sock.groupFetchAllParticipating();
        let responseText = '📋 *Daftar Grup WhatsApp Anda:*\n\n';
        let count = 0;

        for (const [jid, group] of Object.entries(groups)) {
            try {
                const link = await getGroupInviteLink(sock, jid);
                responseText += `*${++count}. ${group.subject}*\n`;
                responseText += `🔗 Link: ${link}\n\n`;
            } catch (err) {
                responseText += `*${++count}. ${group.subject}*\n`;
                responseText += `❌ Error: ${err.message}\n\n`;
            }
        }

        if (count === 0) {
            responseText = '❌ Tidak ada grup ditemukan!';
        }

        await bot.editMessageText(responseText, {
            chat_id: userId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

    } catch (error) {
        console.error('Error fetching groups:', error);
        await bot.sendMessage(userId, '❌ Gagal mengambil link grup. Silakan coba lagi.');
    }
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    if (!await checkAuthorization(userId, callbackQuery.message)) return;
    
    const data = callbackQuery.data;

    switch (data) {
        case 'connect':
            await bot.sendMessage(userId, '🔄 *Memulai Koneksi WhatsApp*\n\nMohon tunggu...', {
                parse_mode: 'Markdown'
            });
            connectToWhatsApp(userId);
            break;
            
        case 'cancel_login':
            if (qrMessages.has(userId)) {
                await bot.deleteMessage(userId, qrMessages.get(userId));
                qrMessages.delete(userId);
            }
            await bot.sendMessage(userId, '❌ Koneksi dibatalkan\n\nPilih opsi:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔄 Hubungkan WhatsApp', callback_data: 'connect' }
                    ]]
                }
            });
            break;
            
        case 'logout':
            const sock = sessions.get(userId);
            if (sock) {
                try {
                    await sock.logout();
                    sessions.delete(userId);
                    await clearSession(userId);
                    await bot.sendMessage(userId, '✅ *Berhasil logout dari WhatsApp*\n\n' +
                        'Pilih opsi untuk melanjutkan:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Hubungkan WhatsApp', callback_data: 'connect' }
                            ]]
                        }
                    });
                } catch (error) {
                    console.error('Logout error:', error);
                    await bot.sendMessage(userId, '❌ Error saat logout. Silakan coba lagi.');
                }
            }
            break;
            
        case 'create_group':
            const waSocket = sessions.get(userId);
            if (!waSocket) {
                await bot.sendMessage(userId, '❌ *WhatsApp belum terhubung!*\n\n' +
                    'Silakan hubungkan WhatsApp terlebih dahulu:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔄 Hubungkan WhatsApp', callback_data: 'connect' }
                        ]]
                    }
                });
                return;
            }
            
            await bot.sendMessage(userId, '📁 *Kirim File Kontak VCF*\n\n' +
                '1. Export kontak dari HP Anda sebagai file VCF\n' +
                '2. Kirim file VCF tersebut ke sini\n' +
                '3. Tunggu proses selesai\n\n' +
                '⚠️ Pastikan semua nomor adalah nomor WhatsApp yang valid', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_vcf');
            break;
            
        case 'confirm_contacts':
            await bot.sendMessage(userId, '✏️ *Masukkan Nama Grup*\n\n' +
                'Silakan kirim nama untuk grup WhatsApp baru Anda.\n\n' +
                '⚠️ Nama grup harus antara 1-25 karakter', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_group_name');
            break;
            
        case 'cancel_group':
            userStates.delete(userId);
            sessions.delete(userId + '_contacts');
            
            await bot.sendMessage(userId, '❌ Pembuatan grup dibatalkan\n\n' +
                'Pilih opsi:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '📱 Buat Grup Baru', callback_data: 'create_group' },
                        { text: '🚪 Logout', callback_data: 'logout' }
                    ]]
                }
            });
            break;
    }
});

// VCF file handler
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    const state = userStates.get(userId);
    if (state !== 'waiting_vcf') return;
    
    const sock = sessions.get(userId);
    if (!sock) {
        await bot.sendMessage(userId, '❌ WhatsApp belum terhubung!');
        return;
    }

    try {
        const processingMsg = await bot.sendMessage(userId, 
            '⏳ *Memproses File VCF*\n\n' +
            '• Membaca isi file...\n' +
            '• Validasi format kontak...\n' +
            '• Menyiapkan daftar kontak...\n\n' +
            'Mohon tunggu...', {
            parse_mode: 'Markdown'
        });
        
        const file = await bot.getFile(msg.document.file_id);
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        const vcfContent = await response.text();
        
        const contacts = parseVCF(vcfContent);
        
        if (contacts.length === 0) {
            await bot.editMessageText('❌ Tidak ada kontak valid dalam file VCF.\n\nSilakan cek file dan coba lagi.', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            return;
        }
        
        sessions.set(userId + '_contacts', contacts);
        
        const confirmMessage = `📋 *Pemrosesan Kontak Selesai*\n\n` +
            `📱 Total Kontak Ditemukan: ${contacts.length}\n\n` +
            `Silakan konfirmasi untuk melanjutkan:`;
            
        await bot.editMessageText(confirmMessage, {
            chat_id: userId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Lanjutkan', callback_data: 'confirm_contacts' },
                    { text: '❌ Batal', callback_data: 'cancel_group' }
                ]]
            }
        });
        
        userStates.set(userId, 'confirming_contacts');
        
    } catch (error) {
        console.error('VCF processing error:', error);
        await bot.sendMessage(userId, '❌ Gagal memproses file VCF.\n\nSilakan cek format file dan coba lagi.');
    }
});

// Group name handler
bot.on('text', async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    const state = userStates.get(userId);
    if (state !== 'waiting_group_name') return;
    
    const sock = sessions.get(userId);
    const contacts = sessions.get(userId + '_contacts');
    const groupName = msg.text.trim();
    
    if (groupName.length > 25) {
        await bot.sendMessage(userId, '❌ *Error:* Nama grup terlalu panjang!\n\n' +
            'Mohon kirimkan nama yang lebih pendek (maksimal 25 karakter)', {
            parse_mode: 'Markdown'
        });
        return;
    }
    
    try {
        const statusMsg = await bot.sendMessage(userId, 
            '⏳ *Membuat Grup WhatsApp*\n\n' +
            '• Menyiapkan kontak...\n' +
            '• Memulai pembuatan grup...\n' +
            '• Menambahkan member...\n\n' +
            'Mohon tunggu...', {
            parse_mode: 'Markdown'
        });
        
        // Format participants properly
        const validParticipants = [...new Set(contacts)].map(id => ({
            id: id.includes('@s.whatsapp.net') ? id : `${id}@s.whatsapp.net`
        }));
        
        // Create group with retry mechanism
        let retries = 3;
        let group = null;
        
        while (retries > 0 && !group) {
            try {
                group = await sock.groupCreate(
                    groupName,
                    validParticipants
                );
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (group && group.id) {
            // Wait for group to be properly created
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            try {
                const groupInfo = await sock.groupMetadata(group.id);
                const successfulMembers = groupInfo.participants.length;
                const failedMembers = contacts.length - successfulMembers;
                const successRate = ((successfulMembers / contacts.length) * 100).toFixed(1);
                const displayGroupId = group.id.split('@')[0];
                
                const successMessage = `✅ *Grup WhatsApp Berhasil Dibuat!*\n\n` +
                    `📱 *Detail Grup:*\n` +
                    `• Nama: ${groupName}\n` +
                    `• ID: ${displayGroupId}\n\n` +
                    `👥 *Statistik Member:*\n` +
                    `• Total Kontak: ${contacts.length}\n` +
                    `• Berhasil Ditambahkan: ${successfulMembers}\n` +
                    `• Gagal Ditambahkan: ${failedMembers}\n` +
                    `• Tingkat Keberhasilan: ${successRate}%\n\n` +
                    (failedMembers > 0 ? 
                        `ℹ️ *Catatan:* Beberapa member tidak bisa ditambahkan karena:\n` +
                        `• Nomor tidak valid\n` +
                        `• Nomor tidak terdaftar di WhatsApp\n` +
                        `• Pengaturan privasi\n` +
                        `• Batasan WhatsApp lainnya\n\n` : 
                        `🌟 *Sempurna! Semua member berhasil ditambahkan!*\n\n`) +
                    `Pilih tindakan selanjutnya:`;

                await bot.editMessageText(successMessage, {
                    chat_id: userId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Buat Grup Baru', callback_data: 'create_group' },
                            { text: '🚪 Logout', callback_data: 'logout' }
                        ]]
                    }
                });

                // Get and send group link
                try {
                    const groupLink = await getGroupInviteLink(sock, group.id);
                    await bot.sendMessage(userId, 
                        `🔗 *Link Grup:*\n${groupLink}\n\n` +
                        `Anda bisa menggunakan link di atas untuk mengundang member tambahan.`, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });
                } catch (linkError) {
                    console.error('Error getting group link:', linkError);
                    await bot.sendMessage(userId, 
                        '⚠️ *Catatan:* Tidak bisa mengambil link grup secara otomatis.\n' +
                        'Silakan buat link undangan manual di WhatsApp.', {
                        parse_mode: 'Markdown'
                    });
                }

                // Clear states
                userStates.delete(userId);
                sessions.delete(userId + '_contacts');
                
            } catch (metadataError) {
                console.error('Error getting group metadata:', metadataError);
                throw new Error('Gagal mendapatkan informasi grup');
            }
        } else {
            throw new Error('Pembuatan grup gagal');
        }
        
    } catch (error) {
        console.error('Group creation error:', error);
        await bot.sendMessage(userId, 
            '❌ *Gagal Membuat Grup*\n\n' +
            'Gagal membuat grup WhatsApp.\n' +
            'Silakan coba lagi atau hubungi support.\n\n' +
            'Masalah umum:\n' +
            '• Masalah koneksi internet\n' +
            '• Masalah server WhatsApp\n' +
            '• Nomor kontak tidak valid\n\n' +
            'Pilih opsi:', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Coba Lagi', callback_data: 'create_group' },
                    { text: '🚪 Logout', callback_data: 'logout' }
                ]]
            }
        });
    }
});
