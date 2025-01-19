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

// Initialize logger with minimal output
const logger = pino({ level: 'silent' });

// Configuration constants
const TELEGRAM_TOKEN = '7711523807:AAE_VG5Su-U24cnuuMuPjcadYd86pAOCfNI';
const AUTHORIZED_USERS = [6022261644, 5988451717];
const WATERMARK = 'created @hiyaok';
const MAX_RETRIES = 5;
const BATCH_SIZE = 5;

// Initialize bot with polling
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store management
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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced session cleanup
async function cleanupSession(userId) {
    const session = sessions.get(userId);
    if (session) {
        try {
            if (session.sock) {
                await session.sock.logout().catch(() => {});
                await session.sock.end().catch(() => {});
            }

            const sessionPath = createSessionFolder(userId);
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error('Error in session cleanup:', err);
        } finally {
            sessions.delete(userId);
        }
    }
}

// Enhanced error handler
async function handleConnectionError(userId, chatId, error) {
    try {
        await cleanupSession(userId);
        await bot.sendMessage(chatId,
            `❌ Error connecting to WhatsApp\nPlease try again using /start\n\n` +
            `Error: ${error.message || 'Unknown error'}\n\n${WATERMARK}`
        );
    } catch (err) {
        console.error('Error in error handler:', err);
    }
}

// Improved WhatsApp connection
async function connectToWhatsApp(userId, msg) {
    try {
        const sessionPath = createSessionFolder(userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Safari'),
            logger: logger,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            emitOwnEvents: false,
            retryRequestDelayMs: 2000,
            markOnlineOnConnect: false
        });

        sessions.set(userId, { 
            sock, 
            qrMsg: null, 
            active: false,
            connectionAttempts: 0
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = sessions.get(userId);

            if (!session) return;

            if (qr) {
                try {
                    const qrImage = await qrcode.toBuffer(qr);
                    const cancelButton = {
                        inline_keyboard: [[
                            { text: '❌ Cancel Connection', callback_data: `cancel_${userId}` }
                        ]]
                    };

                    session.connectionAttempts++;

                    if (session.connectionAttempts > 3) {
                        await bot.sendMessage(msg.chat.id, 
                            `⚠️ Multiple connection attempts detected. Please try again by using /start\n\n${WATERMARK}`
                        );
                        await cleanupSession(userId);
                        return;
                    }

                    const qrCaption = `📱 Scan this QR code to connect your WhatsApp\n\n` +
                                    `Attempt ${session.connectionAttempts}/3\n` +
                                    `QR code will refresh automatically if expired\n\n${WATERMARK}`;

                    if (session.qrMsg) {
                        try {
                            await bot.editMessageMedia({
                                type: 'photo',
                                media: qrImage,
                                caption: qrCaption
                            }, {
                                chat_id: msg.chat.id,
                                message_id: session.qrMsg.message_id,
                                reply_markup: cancelButton
                            });
                        } catch (err) {
                            const newQrMsg = await bot.sendPhoto(msg.chat.id, qrImage, {
                                caption: qrCaption,
                                reply_markup: cancelButton
                            });
                            if (newQrMsg) {
                                session.qrMsg = newQrMsg;
                            }
                        }
                    } else {
                        const qrMsg = await bot.sendPhoto(msg.chat.id, qrImage, {
                            caption: qrCaption,
                            reply_markup: cancelButton
                        });
                        if (qrMsg) {
                            session.qrMsg = qrMsg;
                        }
                    }
                } catch (error) {
                    console.error('Error handling QR code:', error);
                    await handleConnectionError(userId, msg.chat.id, error);
                }
            }

            if (connection === 'open' && session) {
                try {
                    session.active = true;
                    session.connectionAttempts = 0;

                    if (session.qrMsg) {
                        try {
                            await bot.deleteMessage(msg.chat.id, session.qrMsg.message_id);
                        } catch (err) {
                            console.error('Error deleting QR message:', err);
                        }
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
                        `✅ *WhatsApp Connected Successfully!*\n\n` +
                        `📱 *Account Details*\n` +
                        `• Number: ${userInfo.id.split(':')[0]}\n` +
                        `• Name: ${userInfo.name}\n` +
                        `• Device: ${userInfo.platform}\n\n` +
                        `Select an action below:\n\n` +
                        `${WATERMARK}`,
                        { 
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        }
                    );
                } catch (error) {
                    console.error('Error handling connection open:', error);
                    await handleConnectionError(userId, msg.chat.id, error);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && session && !session.active) {
                    await delay(2000);
                    connectToWhatsApp(userId, msg);
                } else {
                    try {
                        await cleanupSession(userId);
                        await bot.sendMessage(msg.chat.id, 
                            `❌ WhatsApp session ended\nUse /start to create new session\n\n${WATERMARK}`
                        );
                    } catch (error) {
                        console.error('Error handling connection close:', error);
                    }
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        await handleConnectionError(userId, msg.chat.id, error);
    }
}

// Improved VCF processing
async function processVCF(vcfContent) {
    const phoneNumbers = new Set();
    const vcfLines = vcfContent.split('\n');

    for (const line of vcfLines) {
        if (line.startsWith('TEL;') || line.startsWith('TEL:')) {
            let phone = line.split(':')[1].trim().replace(/[^\d+]/g, '');
            
            if (phone.startsWith('+')) {
                phone = phone.substring(1);
            }
            
            if (phone.startsWith('0')) {
                phone = '62' + phone.substring(1);
            } else if (!phone.startsWith('62')) {
                phone = '62' + phone;
            }

            if (phone.length >= 10 && phone.length <= 15) {
                phoneNumbers.add(phone);
            }
        }
    }

    return Array.from(phoneNumbers);
}

// Enhanced group link retrieval
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
        const getGroups = async (retries = MAX_RETRIES) => {
            for (let i = 0; i < retries; i++) {
                try {
                    const groups = await session.sock.groupFetchAllParticipating();
                    await delay(2000);
                    return groups;
                } catch (err) {
                    console.error(`Retry ${i + 1} failed:`, err);
                    if (i === retries - 1) throw err;
                    await delay(5000);
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

        for (let i = 0; i < groupEntries.length; i += BATCH_SIZE) {
            const batch = groupEntries.slice(i, i + BATCH_SIZE);
            
            for (const [groupId, groupInfo] of batch) {
                try {
                    const participants = groupInfo.participants || [];
                    const userJid = session.sock.user.id;
                    const isAdmin = participants.some(p => 
                        p.id === userJid && (p.admin === 'admin' || p.admin === 'superadmin')
                    );

                    if (!isAdmin) {
                        noPermissionGroups.push(groupInfo.subject || 'Unknown Group');
                        continue;
                    }

                    const getInviteCode = async (retries = MAX_RETRIES) => {
                        for (let i = 0; i < retries; i++) {
                            try {
                                const code = await session.sock.groupInviteCode(groupId);
                                await delay(1000);
                                return code;
                            } catch (err) {
                                console.error(`Retry ${i + 1} failed for group ${groupInfo.subject}:`, err);
                                if (i === retries - 1) throw err;
                                await delay(Math.min(1000 * Math.pow(2, i), 10000));
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

                        if (results.length % 5 === 0) {
                            await bot.editMessageText(
                                `🔄 Retrieved ${results.length}/${groupEntries.length} group links...\n\n${WATERMARK}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }).catch(() => {});
                        }
                    }
                } catch (err) {
                    console.error(`Failed to get invite code for group ${groupInfo.subject}:`, err);
                    failedGroups.push(groupInfo.subject || 'Unknown Group');
                }
                
                await delay(3000);
            }
            
            await delay(5000);
        }

        results.sort((a, b) => a.name.localeCompare(b.name));

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
        
        try {
            await bot.deleteMessage(chatId, statusMsg.message_id);
        } catch (err) {
            console.error('Error deleting status message:', err);
        }

        await bot.sendDocument(chatId, fileName, {
            caption: `✅ Retrieved ${results.length} group links\n` +
                    `⚠️ No Admin: ${noPermissionGroups.length}\n` +
                    `❌ Failed: ${failedGroups.length}\n` +
                    `📊 Total Groups: ${groupEntries.length}\n\n${WATERMARK}`
        });
        
        fs.unlinkSync(fileName);

    } catch (error) {
        console.error('Error in group link retrieval:', error);
        const errorMessage = `❌ Error getting group links. Please try again.\nError: ${error.message}\n\n${WATERMARK}`;
        
        try {
            await bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
        } catch (err) {
            await bot.sendMessage(chatId, errorMessage);
        }
    }
}

// Enhanced logout function
async function logoutWhatsApp(userId, chatId) {
    const session = sessions.get(userId);
    if (!session || !session.sock) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    const statusMsg = await bot.sendMessage(chatId, '🔄 Logging out...');

    try {
        const performLogout = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    await session.sock.logout();
                    await delay(1000);
                    await session.sock.end();
                    return true;
                } catch (err) {
                    console.error(`Logout retry ${i + 1} failed:`, err);
                    if (i === retries - 1) throw err;
                    await delay(2000);
                }
            }
        };

        await performLogout();
        
        const sessionPath = createSessionFolder(userId);
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error('Error cleaning session files:', err);
        }
        
        sessions.delete(userId);
        
        const keyboard = {
            inline_keyboard: [[
                { text: '📱 Connect Again', callback_data: `connect_${userId}` }
            ]]
        };

        await bot.editMessageText(
            `✅ Successfully logged out from WhatsApp\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                reply_markup: keyboard
            }
        );
    } catch (error) {
        console.error('Error during logout:', error);
        
        try {
            const sessionPath = createSessionFolder(userId);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            sessions.delete(userId);
        } catch (err) {
            console.error('Error in force cleanup:', err);
        }

        await bot.editMessageText(
            `⚠️ Logout completed with some errors.\nPlease reconnect using /start\n\n${WATERMARK}`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id
            }
        );
    }
}

// Enhanced group creation handler
async function handleCreate(chatId, userId) {
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(chatId, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    pendingGroupCreations.delete(userId);

    const message = `📱 Send me a VCF file containing the contacts you want to add to the group.\n\n` +
                   `Requirements:\n` +
                   `• File must be in .vcf format\n` +
                   `• Maximum 256 contacts per group\n` +
                   `• Valid phone numbers only\n` +
                   `• Supports contacts from any country 🌍\n\n` +
                   `${WATERMARK}`;

    await bot.sendMessage(chatId, message);
}

// Bot command handlers
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

// Callback query handler
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!isAuthorized(userId)) {
        await bot.answerCallbackQuery(query.id, {
            text: 'You are not authorized to use this bot.',
            show_alert: true
        });
        return;
    }

    if (data === 'get_links') {
        await bot.answerCallbackQuery(query.id);
        await handleLink(chatId, userId);
    } 
    else if (data === 'create_new') {
        await bot.answerCallbackQuery(query.id);
        await handleCreate(chatId, userId);
    }
    else if (data === 'do_logout') {
        await bot.answerCallbackQuery(query.id);
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
                await cleanupSession(userId);
                
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
                                    const code = await session.sock.groupInviteCode(createResult.id);
                                    await delay(1000);
                                    return code;
                                } catch (err) {
                                    if (i === retries - 1) throw err;
                                    await delay(2000);
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

// Document handler for VCF files
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

        const phoneNumbers = await processVCF(vcfContent);

        if (phoneNumbers.length === 0) {
            throw new Error('No valid phone numbers found in VCF');
        }

        if (phoneNumbers.length > 256) {
            throw new Error('Maximum 256 contacts allowed per group');
        }

        pendingGroupCreations.set(userId, phoneNumbers);

        const confirmButtons = {
            inline_keyboard: [[
                { text: '✅ Create Group', callback_data: `create_group_${userId}` },
                { text: '❌ Cancel', callback_data: `cancel_group_${userId}` }
            ]]
        };

        await bot.editMessageText(
            `📱 Found ${phoneNumbers.length} valid contacts\n\n` +
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

// Error handlers
bot.on('polling_error', (error) => {
    console.error('Polling Error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Cleanup handlers
async function cleanUp() {
    console.log('Cleaning up...');
    const cleanupPromises = [];

    for (const [userId, session] of sessions.entries()) {
        cleanupPromises.push(
            (async () => {
                try {
                    await cleanupSession(userId);
                } catch (error) {
                    console.error(`Error cleaning up session for user ${userId}:`, error);
                })()
        );
    }

    try {
        await Promise.allSettled(cleanupPromises);
    } catch (error) {
        console.error('Error in cleanup:', error);
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
console.log('🚀 WhatsApp Bot is running...');

// Helper function for exponential backoff
function getExponentialDelay(retryCount, baseDelay = 1000, maxDelay = 10000) {
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    return delay + Math.random() * 1000; // Add jitter
}

// Helper function for handling group operations with retries
async function withRetry(operation, maxRetries = 3, baseDelay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = getExponentialDelay(i, baseDelay);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Helper function to validate group name
function validateGroupName(name) {
    if (!name || typeof name !== 'string') return false;
    name = name.trim();
    if (name.length < 1 || name.length > 50) return false;
    // Add additional validation if needed
    return true;
}

// Helper function to format phone numbers
function formatPhoneNumber(phone) {
    phone = phone.replace(/[^\d+]/g, '');
    if (phone.startsWith('+')) phone = phone.substring(1);
    if (phone.startsWith('0')) phone = '62' + phone.substring(1);
    if (!phone.startsWith('62')) phone = '62' + phone;
    return phone;
}

// Helper function to check admin status
function isGroupAdmin(participants, userJid) {
    return participants.some(p => 
        p.id === userJid && (p.admin === 'admin' || p.admin === 'superadmin')
    );
}

// Helper function to ensure safe message editing
async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        });
    } catch (error) {
        console.error('Error editing message:', error);
        // Fallback to sending new message if editing fails
        try {
            await bot.sendMessage(chatId, text, options);
        } catch (err) {
            console.error('Error sending fallback message:', err);
        }
    }
}

// Helper function to safely delete messages
async function safeDeleteMessage(bot, chatId, messageId) {
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (error) {
        console.error('Error deleting message:', error);
    }
}

// Helper function for handling WhatsApp errors
function handleWhatsAppError(error) {
    const errorMessage = error.message || 'Unknown error occurred';
    const isConnectionError = errorMessage.toLowerCase().includes('connection') ||
                            errorMessage.toLowerCase().includes('timeout') ||
                            errorMessage.toLowerCase().includes('network');
    
    if (isConnectionError) {
        return {
            message: '📶 Connection error. Please check your internet connection and try again.',
            shouldRetry: true
        };
    }

    if (errorMessage.includes('not-authorized') || errorMessage.includes('auth')) {
        return {
            message: '🔒 Authorization error. Please logout and reconnect your WhatsApp.',
            shouldRetry: false
        };
    }

    // Generic error handling
    return {
        message: `❌ Error: ${errorMessage}`,
        shouldRetry: false
    };
}

module.exports = {
    bot,
    sessions,
    cleanUp,
    handleWhatsAppError,
    validateGroupName,
    formatPhoneNumber,
    isGroupAdmin,
    safeEditMessage,
    safeDeleteMessage,
    withRetry
};
