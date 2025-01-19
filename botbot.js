// Required dependencies
const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const vcard = require('vcard-parser');
const util = require('util');
const readFile = util.promisify(fs.readFile);
const fetch = require('node-fetch');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();

// Initialize logger
const logger = pino({ level: 'silent' });

// Telegram Bot Token
const TELEGRAM_TOKEN = '7711523807:AAE_VG5Su-U24cnuuMuPjcadYd86pAOCfNI';

// Authorized User IDs - Hanya ID ini yang bisa akses bot
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Watermark
const WATERMARK = 'created @hiyaok';

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store active sessions and pending group creations
const sessions = new Map();
const pendingGroupCreations = new Map();

// Fungsi untuk cek apakah user diizinkan menggunakan bot
const isAuthorized = (userId) => AUTHORIZED_USERS.includes(userId);

// Fungsi untuk format nomor telepon internasional
function formatPhoneNumber(number) {
    try {
        // Bersihkan nomor dari karakter non-angka
        let cleaned = number.replace(/[^\d+]/g, '');
        
        // Jika nomor tidak diawali +, cek kode negara
        if (!cleaned.startsWith('+')) {
            // Handle format umum
            if (cleaned.startsWith('0')) {
                // Asumsi nomor lokal Indonesia, tambah 62
                cleaned = '62' + cleaned.substring(1);
            } else if (!cleaned.match(/^\d{1,3}/)) {
                // Jika tidak ada kode negara, default ke Indonesia
                cleaned = '62' + cleaned;
            }
        }

        // Parse nomor dengan libphonenumber
        const phoneNumber = phoneUtil.parse(cleaned);
        
        // Ambil kode negara dan nomor nasional
        const countryCode = phoneNumber.getCountryCode();
        const nationalNumber = phoneNumber.getNationalNumber().toString();
        
        // Return nomor yang sudah diformat (tanpa +)
        return `${countryCode}${nationalNumber}`;
    } catch (error) {
        console.error('Error formatting phone number:', error);
        // Jika gagal parsing, return nomor asli yang dibersihkan
        return number.replace(/[^\d]/g, '');
    }
}

// Cek apakah user punya sesi WhatsApp aktif
const hasActiveSession = (userId) => {
    const session = sessions.get(userId);
    return session && session.sock && session.sock.user;
};

// Cek apakah folder sesi ada
const hasExistingSession = (userId) => {
    const sessionPath = path.join(__dirname, 'sessions', userId.toString());
    return fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
};

// Fungsi untuk buat folder sesi
const createSessionFolder = (userId) => {
    const sessionPath = path.join(__dirname, 'sessions', userId.toString());
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }
    return sessionPath;
};

// Handle /start command
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Cek authorization
    if (!isAuthorized(userId)) {
        await bot.sendMessage(chatId, 
            `❌ You are not authorized to use this bot.\n\n${WATERMARK}`
        );
        return;
    }

    // Cek jika sudah ada sesi aktif
    if (hasActiveSession(userId)) {
        await bot.sendMessage(chatId,
            `📱 WhatsApp is already connected\n` +
            `Use /link to get group links\n` +
            `Use /create to create new group\n` +
            `Use /logout to disconnect\n\n${WATERMARK}`
        );
        return;
    }

    // Mulai koneksi WhatsApp
    await connectToWhatsApp(userId, msg);
});

// Fungsi koneksi WhatsApp
async function connectToWhatsApp(userId, msg) {
    try {
        // Buat folder sesi
        const sessionPath = createSessionFolder(userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Inisialisasi WhatsApp client
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Safari'),
            logger: logger,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: false,
            retryRequestDelayMs: 2000
        });

        // Simpan sesi
        sessions.set(userId, { sock, qrMsg: null, active: false });

        // Handle update koneksi
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = sessions.get(userId);

            // Jika dapat QR code baru
            if (qr && session) {
                try {
                    // Generate QR code image
                    const qrImage = await qrcode.toBuffer(qr);
                    
                    // Buat tombol cancel
                    const cancelButton = {
                        inline_keyboard: [[
                            { text: '❌ Cancel Connection', callback_data: `cancel_${userId}` }
                        ]]
                    };

                    // Update atau kirim QR code
                    if (session.qrMsg) {
                        await bot.editMessageMedia({
                            type: 'photo',
                            media: qrImage,
                            caption: `📱 Scan this QR code to connect your WhatsApp\n\nQR code will automatically refresh if expired\n\n${WATERMARK}`
                        }, {
                            chat_id: msg.chat.id,
                            message_id: session.qrMsg.message_id,
                            reply_markup: cancelButton
                        }).catch(console.error);
                    } else {
                        const qrMsg = await bot.sendPhoto(msg.chat.id, qrImage, {
                            caption: `📱 Scan this QR code to connect your WhatsApp\n\nQR code will automatically refresh if expired\n\n${WATERMARK}`,
                            reply_markup: cancelButton
                        }).catch(console.error);
                        if (qrMsg) {
                            session.qrMsg = qrMsg;
                        }
                    }
                } catch (error) {
                    console.error('Error handling QR code:', error);
                }
            }

            // Jika koneksi berhasil
            if (connection === 'open' && session) {
                try {
                    session.active = true;
                    
                    // Update pesan QR code
                    if (session.qrMsg) {
                        await bot.editMessageCaption('✅ WhatsApp Connected Successfully!', {
                            chat_id: msg.chat.id,
                            message_id: session.qrMsg.message_id
                        }).catch(console.error);
                    }

                    // Kirim info akun
                    const userInfo = sock.user;
                    await bot.sendMessage(msg.chat.id, 
                        `📱 *Connected WhatsApp Account* ✅\n` +
                        `• Number: ${userInfo.id.split(':')[0]}\n` +
                        `• Name: ${userInfo.name}\n` +
                        `• Device: ${userInfo.platform}\n\n` +
                        `Use /link to get group invite links 👀\n` +
                        `Use /create to create new group 🔰\n` +
                        `Use /logout to disconnect WhatsApp 💡\n\n` +
                        `${WATERMARK}`,
                        { parse_mode: 'Markdown' }
                    ).catch(console.error);
                } catch (error) {
                    console.error('Error handling connection open:', error);
                }
            }

            // Jika koneksi terputus
            if (connection === 'close') {
                try {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect && session && !session.active) {
                        connectToWhatsApp(userId, msg);
                    } else {
                        await bot.sendMessage(msg.chat.id, 
                            `❌ WhatsApp session ended\nUse /start to create new session\n\n${WATERMARK}`
                        ).catch(console.error);
                        sessions.delete(userId);
                    }
                } catch (error) {
                    console.error('Error handling connection close:', error);
                }
            }
        });

        // Save credentials saat update
        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        await bot.sendMessage(msg.chat.id,
            `❌ Error connecting to WhatsApp\nPlease try again later\n\n${WATERMARK}`
        ).catch(console.error);
    }
}

// Handle /create command
bot.onText(/\/create/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Cek authorization
    if (!isAuthorized(userId)) {
        await bot.sendMessage(chatId, 
            `❌ You are not authorized to use this bot.\n\n${WATERMARK}`
        );
        return;
    }

    // Cek sesi WhatsApp
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    // Hapus data pembuatan grup yang pending (jika ada)
    pendingGroupCreations.delete(userId);

    // Minta file VCF
    await bot.sendMessage(chatId,
        `📱 Send me a VCF file containing the contacts you want to add to the group.\n\n` +
        `Note: The file should be in .vcf format\n` +
        `Supports contacts from any country 🌍\n\n${WATERMARK}`
    );
});

// Handle file yang diupload
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Skip jika user tidak authorized atau tidak ada sesi
    if (!isAuthorized(userId)) return;
    if (!hasActiveSession(userId)) return;

    const file = msg.document;
    // Cek apakah file VCF
    if (!file.file_name.toLowerCase().endsWith('.vcf')) {
        await bot.sendMessage(chatId,
            `❌ Please send a valid VCF file\n\n${WATERMARK}`
        );
        return;
    }

    // Kirim pesan proses
    const statusMsg = await bot.sendMessage(chatId, 
        '🔄 Processing contacts file...'
    );

    try {
        // Download file VCF
        const fileLink = await bot.getFile(file.file_id);
        const response = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileLink.file_path}`);
        const vcfContent = await response.text();

        // Parse konten VCF
        const contacts = vcard.parse(vcfContent);
        const phoneNumbers = new Set();

        // Ekstrak dan format nomor telepon
        contacts.forEach(contact => {
            if (contact.tel) {
                const numbers = Array.isArray(contact.tel) ? contact.tel : [contact.tel];
                numbers.forEach(num => {
                    try {
                        const formattedNumber = formatPhoneNumber(num.value);
                        if (formattedNumber) {
                            phoneNumbers.add(formattedNumber);
                        }
                    } catch (error) {
                        console.error('Error formatting number:', error);
                    }
                });
            }
        });

        // Simpan nomor-nomor untuk pembuatan grup
        pendingGroupCreations.set(userId, Array.from(phoneNumbers));

        // Buat tombol konfirmasi
        const confirmButtons = {
            inline_keyboard: [[
                { text: '✅ Create Group', callback_data: `create_group_${userId}` },
                { text: '❌ Cancel', callback_data: `cancel_group_${userId}` }
            ]]
        };

        // Update pesan status dengan hasil dan tombol
        await bot.editMessageText(
            `📱 Found ${phoneNumbers.size} valid contacts\n\n` +
            `Would you like to create a new group with these contacts?\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                reply_markup: confirmButtons
            }
        );

    } catch (error) {
        console.error('Error processing VCF:', error);
        await bot.editMessageText(
            `❌ Error processing the contacts file. Please try again.\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Handle callback queries (tombol inline)
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    // Handle tombol Create Group
    if (data.startsWith('create_group_')) {
        const phoneNumbers = pendingGroupCreations.get(userId);
        if (!phoneNumbers) {
            await bot.answerCallbackQuery(query.id);
            await bot.editMessageText(
                `❌ Session expired. Please start over.\n\n${WATERMARK}`,
                {
                    chat_id: chatId,
                    message_id: query.message.message_id
                }
            );
            return;
        }

        // Jawab callback dan minta nama grup
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId,
            `📝 Please send the name for your new group:`
        );

        // Setup listener untuk nama grup
        const messageListener = async (msg) => {
            if (msg.from.id === userId) {
                const groupName = msg.text.trim();
                
                // Validasi nama grup
                if (groupName.length < 1 || groupName.length > 50) {
                    await bot.sendMessage(chatId,
                        `❌ Group name must be between 1 and 50 characters.\n\n${WATERMARK}`
                    );
                    return;
                }

                // Kirim pesan proses
                const statusMsg = await bot.sendMessage(chatId,
                    '🔄 Creating group and adding members...'
                );

                try {
                    const session = sessions.get(userId);
                    
                    // Format nomor untuk WhatsApp
                    const formattedNumbers = phoneNumbers.map(num => `${num}@s.whatsapp.net`);
                    
                    // Buat grup dengan retry mechanism
                    const createResult = await session.sock.groupCreate(
                        groupName,
                        formattedNumbers,
                        { timeout: 60000 }  // 60 detik timeout
                    );

                    if (createResult && createResult.id) {
                        // Dapatkan kode invite grup
                        const getInviteCode = async (groupId, retries = 3) => {
                            for (let i = 0; i < retries; i++) {
                                try {
                                    return await session.sock.groupInviteCode(groupId);
                                } catch (err) {
                                    if (i === retries - 1) throw err;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            }
                        };

                        // Generate link grup
                        const inviteCode = await getInviteCode(createResult.id);
                        const groupLink = `https://chat.whatsapp.com/${inviteCode}`;

                        // Hitung berhasil/gagal
                        const addedParticipants = createResult.participants || [];
                        const successCount = addedParticipants.length;
                        const failedCount = phoneNumbers.length - successCount;

                        // Kirim pesan sukses dengan info detail
                        await bot.editMessageText(
                            `✅ Group created successfully!\n\n` +
                            `📱 Group Name: ${groupName}\n` +
                            `👥 Members Added: ${successCount}\n` +
                            `❌ Failed to Add: ${failedCount}\n` +
                            `🔗 Group Link: ${groupLink}\n\n` +
                            `${WATERMARK}`,
                            {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }
                        );
                    } else {
                        throw new Error('Invalid create result');
                    }

                } catch (error) {
                    console.error('Error creating group:', error);
                    await bot.editMessageText(
                        `❌ Failed to create group. Error: ${error.message}\n\n${WATERMARK}`,
                        {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }
                    );
                }

                // Cleanup
                pendingGroupCreations.delete(userId);
                bot.removeListener('message', messageListener);
            }
        };

        // Tambahkan listener untuk nama grup
        bot.on('message', messageListener);

    // Handle tombol Cancel
    } else if (data.startsWith('cancel_group_')) {
        pendingGroupCreations.delete(userId);
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageText(
            `❌ Group creation cancelled\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: query.message.message_id
            }
        );
    }
});

// Handle /link command
bot.onText(/\/link/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Cek authorization
    if (!isAuthorized(userId)) {
        await bot.sendMessage(chatId, 
            `❌ You are not authorized to use this bot.\n\n${WATERMARK}`
        );
        return;
    }
    
    // Cek sesi WhatsApp
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    // Kirim pesan proses
    const statusMsg = await bot.sendMessage(chatId, '🔄 Getting group links...');
    const session = sessions.get(userId);

    try {
        // Ambil semua grup dengan retry mechanism
        const getGroups = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    const groups = await session.sock.groupFetchAllParticipating();
                    return groups;
                } catch (err) {
                    if (i === retries - 1) throw err;
                    await new Promise(r => setTimeout(r, 2000)); // Tunggu 2 detik sebelum retry
                }
            }
        };

        // Dapatkan daftar grup
        const groups = await getGroups();
        if (!groups || Object.keys(groups).length === 0) {
            await bot.editMessageText(
                `ℹ️ No groups found in your WhatsApp account.\n\n${WATERMARK}`, {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
            return;
        }

        const groupEntries = Object.entries(groups);
        let results = [];
        let failedGroups = [];

        // Proses setiap grup
        for (const [groupId, groupInfo] of groupEntries) {
            try {
                // Dapatkan kode invite dengan retry
                const getInviteCode = async (retries = 3) => {
                    for (let i = 0; i < retries; i++) {
                        try {
                            return await session.sock.groupInviteCode(groupId);
                        } catch (err) {
                            if (i === retries - 1) throw err;
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                };

                const inviteCode = await getInviteCode();
                if (inviteCode) {
                    results.push({
                        name: groupInfo.subject || 'Unknown Group',
                        link: `https://chat.whatsapp.com/${inviteCode}`,
                        participants: groupInfo.participants?.length || 0
                    });
                }
            } catch (err) {
                console.error(`Failed to get invite code for group ${groupInfo.subject}:`, err);
                failedGroups.push(groupInfo.subject || 'Unknown Group');
                continue;
            }
            
            // Delay antara request untuk prevent rate limit
            await new Promise(r => setTimeout(r, 1000));
        }

        // Sort grup berdasarkan nama
        results.sort((a, b) => a.name.localeCompare(b.name));

        // Buat laporan detail
        let fileContent = '📱 WhatsApp Group Links Report\n\n';
        
        for (const group of results) {
            fileContent += `Group: ${group.name}\n`;
            fileContent += `Members: ${group.participants}\n`;
            fileContent += `Link: ${group.link}\n\n`;
        }
        
        if (failedGroups.length > 0) {
            fileContent += '\n❌ Failed to get links for these groups:\n';
            failedGroups.forEach(name => {
                fileContent += `• ${name}\n`;
            });
        }
        
        fileContent += `\nSuccessful: ${results.length}\n`;
        fileContent += `Failed: ${failedGroups.length}\n`;
        fileContent += `Total Groups: ${groupEntries.length}\n\n`;
        fileContent += WATERMARK;

        // Simpan dan kirim laporan
        const fileName = `whatsapp_groups_${Date.now()}.txt`;
        fs.writeFileSync(fileName, fileContent);
        
        // Delete pesan status dan kirim file
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        await bot.sendDocument(chatId, fileName, {
            caption: `✅ Retrieved ${results.length} group links\n` +
                    `${failedGroups.length > 0 ? `❌ Failed: ${failedGroups.length}\n` : ''}` +
                    `📊 Total Groups: ${groupEntries.length}\n\n${WATERMARK}`
        });
        
        // Hapus file temporary
        fs.unlinkSync(fileName);

    } catch (error) {
        console.error('Error in group link retrieval:', error);
        await bot.editMessageText(
            `❌ Error getting group links. Please try again.\n\n${WATERMARK}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        }).catch(async () => {
            await bot.sendMessage(chatId, 
                `❌ Error getting group links. Please try again.\n\n${WATERMARK}`
            );
        });
    }
});

// Handle /logout command
bot.onText(/\/logout/, async (msg) => {
    const userId = msg.from.id;
    await logoutWhatsApp(userId, msg.chat.id);
});

// Fungsi logout
async function logoutWhatsApp(userId, chatId) {
    if (!isAuthorized(userId)) {
        await bot.sendMessage(chatId, 
            `❌ You are not authorized to use this bot.\n\n${WATERMARK}`
        );
        return;
    }

    const session = sessions.get(userId);
    if (session && session.sock) {
        try {
            // Logout dari WhatsApp
            await session.sock.logout();
            await session.sock.end();
            
            // Hapus file sesi
            const sessionPath = createSessionFolder(userId);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            
            // Hapus dari memory
            sessions.delete(userId);
            
            await bot.sendMessage(chatId, 
                `✅ Successfully logged out from WhatsApp\nUse /start to connect again\n\n${WATERMARK}`
            );
        } catch (error) {
            console.error('Error during logout:', error);
            await bot.sendMessage(chatId, 
                `❌ Error logging out. Please try again.\n\n${WATERMARK}`
            );
        }
    } else {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
    }
}

// Handle polling errors
bot.on('polling_error', (error) => {
    console.error('Polling Error:', error);
});

// Fungsi cleanup untuk handle terminasi proses
async function cleanUp() {
    console.log('Cleaning up...');
    for (const [userId, session] of sessions.entries()) {
        try {
            if (session && session.sock) {
                await session.sock.logout();
                await session.sock.end();
            }
        } catch (error) {
            console.error(`Error cleaning up session for user ${userId}:`, error);
        }
    }
    process.exit(0);
}

// Handle process termination
process.on('SIGINT', cleanUp);
process.on('SIGTERM', cleanUp);

// Create sessions directory if it doesn't exist
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir);
}

// Start the bot
console.log('Bot is running...');

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
