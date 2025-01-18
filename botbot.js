// Required dependencies
const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Initialize logger
const logger = pino({ level: 'silent' });

// Telegram Bot Token - Replace with your token
const TELEGRAM_TOKEN = '7711523807:AAEtufgRVomPgz343abWLEfsVmVaSPB5LLI';

// Watermark
const WATERMARK = '@hiyaok';

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store active sessions
const sessions = new Map();

// Check if user has active session
const hasActiveSession = (userId) => {
    return sessions.has(userId) && sessions.get(userId).sock;
};

// Utility function to create session folder
const createSessionFolder = (userId) => {
    const sessionPath = path.join(__dirname, 'sessions', userId.toString());
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }
    return sessionPath;
};

// WhatsApp connection function
async function connectToWhatsApp(userId, msg) {
    const sessionPath = createSessionFolder(userId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Initialize WhatsApp client with proper configuration
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: logger,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    // Store session
    sessions.set(userId, { sock, qrMsg: null });

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Generate QR code image
            const qrImage = await qrcode.toBuffer(qr);
            
            // Create inline keyboard for cancel button
            const cancelButton = {
                inline_keyboard: [[
                    { text: '❌ Cancel Connection', callback_data: `cancel_${userId}` }
                ]]
            };

            // If there's an existing QR message, edit it. Otherwise, send new
            if (sessions.get(userId).qrMsg) {
                await bot.editMessageMedia({
                    type: 'photo',
                    media: qrImage,
                    caption: `📱 Scan this QR code to connect your WhatsApp\nQR code will automatically refresh if expired\n\n${WATERMARK}`
                }, {
                    chat_id: msg.chat.id,
                    message_id: sessions.get(userId).qrMsg.message_id,
                    reply_markup: cancelButton
                });
            } else {
                const qrMsg = await bot.sendPhoto(msg.chat.id, qrImage, {
                    caption: `📱 Scan this QR code to connect your WhatsApp\nQR code will automatically refresh if expired\n\n${WATERMARK}`,
                    reply_markup: cancelButton
                });
                sessions.get(userId).qrMsg = qrMsg;
            }
        }

        if (connection === 'open') {
            // Connection successful
            await bot.editMessageCaption('✅ WhatsApp Connected Successfully!', {
                chat_id: msg.chat.id,
                message_id: sessions.get(userId).qrMsg.message_id
            });

            // Get user info
            const userInfo = sock.user;
            await bot.sendMessage(msg.chat.id, 
                `📱 *Connected WhatsApp Account*\n` +
                `• Number: ${userInfo.id.split(':')[0]}\n` +
                `• Name: ${userInfo.name}\n` +
                `• Device: ${userInfo.platform}\n\n` +
                `Use /link to get group invite links\n` +
                `Use /logout to disconnect WhatsApp\n\n` +
                `${WATERMARK}`,
                { parse_mode: 'Markdown' }
            );
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp(userId, msg);
            } else {
                // User logged out
                await bot.sendMessage(msg.chat.id, 
                    `❌ WhatsApp session ended\nUse /start to create new session\n\n${WATERMARK}`
                );
                sessions.delete(userId);
            }
        }
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);
}

// Command handlers
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const welcomeMessage = 
        '👋 *WhatsApp Group Link Manager*\n\n' +
        'Available commands:\n' +
        '• /start - Connect WhatsApp account\n' +
        '• /link - Get group invite links\n' +
        '• /logout - Disconnect WhatsApp\n\n' +
        `${WATERMARK}`;
    
    const startButton = {
        inline_keyboard: [[
            { text: '🚀 Connect WhatsApp', callback_data: `start_session_${userId}` }
        ]]
    };
    
    await bot.sendMessage(msg.chat.id, welcomeMessage, {
        reply_markup: startButton,
        parse_mode: 'Markdown'
    });
});

// Handle /link command
bot.onText(/\/link/, async (msg) => {
    const userId = msg.from.id;
    
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(msg.chat.id, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    const statusMsg = await bot.sendMessage(msg.chat.id, '🔄 Getting group links...');
    const session = sessions.get(userId);

    try {
        const groups = await session.sock.groupFetchAllParticipating();
        let successfulGroups = [];
        let failedGroups = [];
        
        for (const group of Object.values(groups)) {
            try {
                const inviteCode = await session.sock.groupInviteCode(group.id);
                successfulGroups.push({
                    name: group.subject,
                    link: `https://chat.whatsapp.com/${inviteCode}`
                });
            } catch (err) {
                failedGroups.push(group.subject);
            }
        }

        // Sort groups alphabetically
        successfulGroups.sort((a, b) => a.name.localeCompare(b.name));
        failedGroups.sort();

        let resultText = '📋 *WhatsApp Group Links*\n\n';
        
        // If there are many successful groups, create a text file
        if (successfulGroups.length > 10) {
            let fileContent = '📋 WhatsApp Group Links\n\n';
            fileContent += 'Successfully Retrieved Links:\n\n';
            
            for (const group of successfulGroups) {
                fileContent += `Group: ${group.name}\n`;
                fileContent += `Link: ${group.link}\n\n`;
            }
            
            fileContent += `\n${WATERMARK}`;

            // Create and send text file
            fs.writeFileSync('group_links.txt', fileContent);
            await bot.sendDocument(msg.chat.id, 'group_links.txt', {
                caption: `📊 Results Summary:\n` +
                        `✅ Successfully retrieved: ${successfulGroups.length} groups\n` +
                        `❌ Failed to retrieve: ${failedGroups.length} groups\n\n` +
                        failedGroups.length > 0 ? 
                            `Failed Groups:\n${failedGroups.map(name => `• ${name}`).join('\n')}\n\n` : '' +
                        WATERMARK
            });
            
            // Clean up file
            fs.unlinkSync('group_links.txt');
        } else {
            // For fewer groups, send as message
            if (successfulGroups.length > 0) {
                resultText += '✅ *Successfully Retrieved Links:*\n\n';
                for (const group of successfulGroups) {
                    resultText += `*${group.name}*\n`;
                    resultText += `${group.link}\n\n`;
                }
            }

            if (failedGroups.length > 0) {
                resultText += '❌ *Failed to Retrieve Links:*\n\n';
                for (const groupName of failedGroups) {
                    resultText += `• ${groupName}\n`;
                }
            }

            resultText += `\n${WATERMARK}`;

            await bot.editMessageText(resultText, {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        await bot.editMessageText(
            `❌ Error fetching group links\nPlease try again later\n\n${WATERMARK}`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id
        });
    }
});

// Handle /logout command
bot.onText(/\/logout/, async (msg) => {
    const userId = msg.from.id;
    
    if (!hasActiveSession(userId)) {
        await bot.sendMessage(msg.chat.id, 
            `❌ No active WhatsApp session\nUse /start to connect first\n\n${WATERMARK}`
        );
        return;
    }

    const session = sessions.get(userId);

    try {
        // Logout from WhatsApp
        await session.sock.logout();
        await session.sock.end();
        
        // Delete session files
        const sessionPath = createSessionFolder(userId);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        
        // Clear session from memory
        sessions.delete(userId);
        
        await bot.sendMessage(msg.chat.id, 
            `✅ Successfully disconnected from WhatsApp\n\n${WATERMARK}`
        );
    } catch (error) {
        await bot.sendMessage(msg.chat.id, 
            `❌ Error during disconnect\nPlease try again\n\n${WATERMARK}`
        );
    }
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;

    if (action.startsWith('start_session_')) {
        await bot.editMessageText('🔄 Initializing WhatsApp connection...', {
            chat_id: msg.chat.id,
            message_id: msg.message_id
        });
        connectToWhatsApp(userId, msg);
    }
    
    if (action.startsWith('cancel_')) {
        const session = sessions.get(userId);
        if (session && session.sock) {
            await session.sock.logout();
            await session.sock.end();
            sessions.delete(userId);
            
            await bot.editMessageCaption(
                `❌ Connection cancelled\n\n${WATERMARK}`, {
                chat_id: msg.chat.id,
                message_id: msg.message_id
            });
        }
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('Telegram Bot Error:', error);
});

// Start the bot
console.log('Bot is running...');
