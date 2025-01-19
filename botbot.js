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

// Initialize logger
const logger = pino({ level: 'silent' });

// Telegram Bot Token
const TELEGRAM_TOKEN = '7711523807:AAE_VG5Su-U24cnuuMuPjcadYd86pAOCfNI';

// Authorized User IDs
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Watermark
const WATERMARK = 'created @hiyaok';

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store sessions
const sessions = new Map();
const pendingGroupCreations = new Map();

// Utility Functions
const isAuthorized = (userId) => AUTHORIZED_USERS.includes(userId);

const hasActiveSession = (userId) => {
    const session = sessions.get(userId);
    return session && session.sock && session.sock.user;
};

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

    if (!isAuthorized(userId)) {
        const keyboard = {
            inline_keyboard: [[
                { text: '👨‍💻 Contact Admin', url: 'https://t.me/hiyaok' }
            ]]
        };
        
        await bot.sendMessage(chatId, 
            `❌ You are not authorized to use this bot.\n\n${WATERMARK}`,
            { reply_markup: keyboard }
        );
        return;
    }

    if (hasActiveSession(userId)) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔗 Get Group Links', callback_data: 'get_links' }],
                [{ text: '➕ Create New Group', callback_data: 'create_new' }],
                [{ text: '🚪 Logout WhatsApp', callback_data: 'do_logout' }]
            ]
        };

        await bot.sendMessage(chatId,
            `📱 WhatsApp is already connected!\n\n` +
            `Select an action below:\n\n${WATERMARK}`,
            { reply_markup: keyboard }
        );
        return;
    }

    const keyboard = {
        inline_keyboard: [[
            { text: '📱 Connect WhatsApp', callback_data: `connect_${userId}` }
        ]]
    };

    await bot.sendMessage(chatId,
        `Welcome! 👋\n\n` +
        `Click the button below to connect your WhatsApp\n\n${WATERMARK}`,
        { reply_markup: keyboard }
    );
});

// Handle callback queries
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'get_links') {
        await bot.answerCallbackQuery(query.id);
        // Trigger /link command
        await handleLink(chatId, userId);
    } 
    else if (data === 'create_new') {
        await bot.answerCallbackQuery(query.id);
        // Trigger /create command
        await handleCreate(chatId, userId);
    }
    else if (data === 'do_logout') {
        await bot.answerCallbackQuery(query.id);
        // Trigger /logout command
        await logoutWhatsApp(userId, chatId);
    }
    else if (data.startsWith('connect_')) {
        await bot.answerCallbackQuery(query.id);
        await connectToWhatsApp(userId, query.message);
    }
    else if (data.startsWith('cancel_')) {
        const session = sessions.get(userId);
        if (session && session.sock) {
            try {
                await session.sock.logout();
                await session.sock.end();
                sessions.delete(userId);
                
                await bot.answerCallbackQuery(query.id);
                await bot.editMessageText(
                    `❌ Connection cancelled\nUse /start to try again\n\n${WATERMARK}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
            } catch (error) {
                console.error('Error cancelling connection:', error);
            }
        }
    }
    else if (data.startsWith('create_group_')) {
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

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId,
            `📝 Please send the name for your new group:`
        );

        const messageListener = async (msg) => {
            if (msg.from.id === userId) {
                const groupName = msg.text.trim();
                
                if (groupName.length < 1 || groupName.length > 50) {
                    await bot.sendMessage(chatId,
                        `❌ Group name must be between 1 and 50 characters.\n\n${WATERMARK}`
                    );
                    return;
                }

                const statusMsg = await bot.sendMessage(chatId,
                    '🔄 Creating group and adding members...'
                );

                try {
                    const session = sessions.get(userId);
                    const formattedNumbers = phoneNumbers.map(num => `${num}@s.whatsapp.net`);
                    
                    const createResult = await session.sock.groupCreate(
                        groupName,
                        formattedNumbers,
                        { timeout: 60000 }
                    );

                    if (createResult && createResult.id) {
                        const getInviteCode = async (retries = 3) => {
                            for (let i = 0; i < retries; i++) {
                                try {
                                    return await session.sock.groupInviteCode(createResult.id);
                                } catch (err) {
                                    if (i === retries - 1) throw err;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            }
                        };

                        const inviteCode = await getInviteCode();
                        const groupLink = `https://chat.whatsapp.com/${inviteCode}`;

                        const addedParticipants = createResult.participants || [];
                        const successCount = addedParticipants.length;
                        const failedCount = phoneNumbers.length - successCount;

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

                pendingGroupCreations.delete(userId);
                bot.removeListener('message', messageListener);
            }
        };

        bot.on('message', messageListener);
    }
    else if (data.startsWith('cancel_group_')) {
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

// Di bagian handle document
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    if (!isAuthorized(userId)) return;
    if (!hasActiveSession(userId)) return;

    const file = msg.document;
    if (!file.file_name.toLowerCase().endsWith('.vcf')) {
        await bot.sendMessage(chatId,
            `❌ Please send a valid VCF file\n\n${WATERMARK}`
        );
        return;
    }

    const statusMsg = await bot.sendMessage(chatId, 
        '🔄 Processing contacts file...'
    );

    try {
        const fileLink = await bot.getFile(file.file_id);
        const response = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileLink.file_path}`);
        const vcfContent = await response.text();

        // Perbaikan parsing VCF
        const phoneNumbers = new Set();
        const vcfLines = vcfContent.split('\n');
        let currentPhone = '';

        for (const line of vcfLines) {
            if (line.startsWith('TEL;') || line.startsWith('TEL:')) {
                currentPhone = line.split(':')[1].trim();
                // Bersihkan nomor
                let phone = currentPhone.replace(/[^\d+]/g, '');
                if (phone.startsWith('0')) {
                    phone = '62' + phone.substring(1);
                } else if (!phone.startsWith('62')) {
                    phone = '62' + phone;
                }
                phoneNumbers.add(phone);
            }
        }

        if (phoneNumbers.size === 0) {
            throw new Error('No valid phone numbers found in VCF');
        }

        pendingGroupCreations.set(userId, Array.from(phoneNumbers));

        const confirmButtons = {
            inline_keyboard: [[
                { text: '✅ Create Group', callback_data: `create_group_${userId}` },
                { text: '❌ Cancel', callback_data: `cancel_group_${userId}` }
            ]]
        };

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
            `❌ Error processing the contacts file. Please try again.\nError: ${error.message}\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// WhatsApp connection function
async function connectToWhatsApp(userId, msg) {
    try {
        const sessionPath = createSessionFolder(userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

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

        sessions.set(userId, { sock, qrMsg: null, active: false });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = sessions.get(userId);

            if (qr && session) {
                try {
                    const qrImage = await qrcode.toBuffer(qr);
                    
                    const cancelButton = {
                        inline_keyboard: [[
                            { text: '❌ Cancel Connection', callback_data: `cancel_${userId}` }
                        ]]
                    };

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

            if (connection === 'open' && session) {
                try {
                    session.active = true;
                    
                    if (session.qrMsg) {
                        await bot.editMessageCaption('✅ WhatsApp Connected Successfully!', {
                            chat_id: msg.chat.id,
                            message_id: session.qrMsg.message_id
                        }).catch(console.error);
                    }

                    const userInfo = sock.user;
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: '🔗 Get Group Links', callback_data: 'get_links' }],
                            [{ text: '➕ Create New Group', callback_data: 'create_new' }],
                            [{ text: '🚪 Logout WhatsApp', callback_data: 'do_logout' }]
                        ]
                    };

                    await bot.sendMessage(msg.chat.id, 
                        `📱 *Connected WhatsApp Account* ✅\n` +
                        `• Number: ${userInfo.id.split(':')[0]}\n` +
                        `• Name: ${userInfo.name}\n` +
                        `• Device: ${userInfo.platform}\n\n` +
                        `Select an action below:\n\n` +
                        `${WATERMARK}`,
                        { 
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        }
                    ).catch(console.error);
                } catch (error) {
                    console.error('Error handling connection open:', error);
                }
            }

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

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        await bot.sendMessage(msg.chat.id,
            `❌ Error connecting to WhatsApp\nPlease try again later\n\n${WATERMARK}`
        ).catch(console.error);
    }
}

// Handle /create command (via function for callback)
async function handleCreate(chatId, userId) {
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    pendingGroupCreations.delete(userId);

    await bot.sendMessage(chatId,
        `📱 Send me a VCF file containing the contacts you want to add to the group.\n\n` +
        `Note: The file should be in .vcf format\n` +
        `Supports contacts from any country 🌍\n\n${WATERMARK}`
    );
}

async function handleLink(chatId, userId) {
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    const statusMsg = await bot.sendMessage(chatId, '🔄 Getting group links...');
    const session = sessions.get(userId);

    try {
        // Get groups with improved error handling
        const getGroups = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    return await session.sock.groupFetchAllParticipating();
                } catch (err) {
                    console.error('Error fetching groups:', err);
                    if (i === retries - 1) throw err;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        };

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
        let noPermissionGroups = [];

        for (const [groupId, groupInfo] of groupEntries) {
            try {
                // Check if user is admin
                const participants = groupInfo.participants || [];
                const userJid = session.sock.user.id;
                const isAdmin = participants.some(p => 
                    p.id === userJid && (p.admin === 'admin' || p.admin === 'superadmin')
                );

                if (!isAdmin) {
                    noPermissionGroups.push(groupInfo.subject || 'Unknown Group');
                    continue;
                }

                // Get invite code with retry and longer timeout
                const getInviteCode = async (retries = 3) => {
                    for (let i = 0; i < retries; i++) {
                        try {
                            return await session.sock.groupInviteCode(groupId);
                        } catch (err) {
                            console.error(`Retry ${i + 1} failed for group ${groupInfo.subject}:`, err);
                            if (i === retries - 1) throw err;
                            await new Promise(r => setTimeout(r, 3000)); // Longer delay
                        }
                    }
                };

                const inviteCode = await getInviteCode();
                if (inviteCode) {
                    results.push({
                        name: groupInfo.subject || 'Unknown Group',
                        link: `https://chat.whatsapp.com/${inviteCode}`,
                        participants: participants.length
                    });
                }
            } catch (err) {
                console.error(`Failed to get invite code for group ${groupInfo.subject}:`, err);
                failedGroups.push(groupInfo.subject || 'Unknown Group');
            }
            
            // Longer delay between requests
            await new Promise(r => setTimeout(r, 2000));
        }

        results.sort((a, b) => a.name.localeCompare(b.name));

        // Create report
        let fileContent = '📱 WhatsApp Group Links Report\n\n';
        
        if (results.length > 0) {
            fileContent += '✅ Successfully Retrieved Groups:\n\n';
            for (const group of results) {
                fileContent += `Group: ${group.name}\n`;
                fileContent += `Members: ${group.participants}\n`;
                fileContent += `Link: ${group.link}\n\n`;
            }
        }
        
        if (noPermissionGroups.length > 0) {
            fileContent += '\n⚠️ Groups where you are not admin:\n';
            noPermissionGroups.forEach(name => {
                fileContent += `• ${name}\n`;
            });
        }

        if (failedGroups.length > 0) {
            fileContent += '\n❌ Failed to get links for these groups:\n';
            failedGroups.forEach(name => {
                fileContent += `• ${name}\n`;
            });
        }
        
        fileContent += `\nSummary:\n`;
        fileContent += `✅ Successful: ${results.length}\n`;
        fileContent += `⚠️ No Admin: ${noPermissionGroups.length}\n`;
        fileContent += `❌ Failed: ${failedGroups.length}\n`;
        fileContent += `📊 Total Groups: ${groupEntries.length}\n\n`;
        fileContent += WATERMARK;

        const fileName = `whatsapp_groups_${Date.now()}.txt`;
        fs.writeFileSync(fileName, fileContent);
        
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        await bot.sendDocument(chatId, fileName, {
            caption: `✅ Retrieved ${results.length} group links\n` +
                    `⚠️ No Admin: ${noPermissionGroups.length}\n` +
                    `❌ Failed: ${failedGroups.length}\n` +
                    `📊 Total Groups: ${groupEntries.length}\n\n${WATERMARK}`
        });
        
        fs.unlinkSync(fileName);

    } catch (error) {
        console.error('Error in group link retrieval:', error);
        await bot.editMessageText(
            `❌ Error getting group links. Please try again.\nError: ${error.message}\n\n${WATERMARK}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        }).catch(async () => {
            await bot.sendMessage(chatId, 
                `❌ Error getting group links. Please try again.\nError: ${error.message}\n\n${WATERMARK}`
            );
        });
    }
}

// Logout function
async function logoutWhatsApp(userId, chatId) {
    const session = sessions.get(userId);
    if (session && session.sock) {
        try {
            await session.sock.logout();
            await session.sock.end();
            
            const sessionPath = createSessionFolder(userId);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            
            sessions.delete(userId);
            
            const keyboard = {
                inline_keyboard: [[
                    { text: '📱 Connect Again', callback_data: `connect_${userId}` }
                ]]
            };

            await bot.sendMessage(chatId, 
                `✅ Successfully logged out from WhatsApp\n\n${WATERMARK}`,
                { reply_markup: keyboard }
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

// Cleanup function
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

// Error Handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
