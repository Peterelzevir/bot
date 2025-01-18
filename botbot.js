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
const WATERMARK = 'created @hiyaok';

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store active sessions
const sessions = new Map();

// Check if user has active session
const hasActiveSession = (userId) => {
    const session = sessions.get(userId);
    return session && session.sock && session.sock.user;
};

// Check if session folder exists
const hasExistingSession = (userId) => {
    const sessionPath = path.join(__dirname, 'sessions', userId.toString());
    return fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
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
    try {
        const sessionPath = createSessionFolder(userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Initialize WhatsApp client with proper configuration
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Safari'),
            logger: logger,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: false
        });

        // Store session
        sessions.set(userId, { sock, qrMsg: null, active: false });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = sessions.get(userId);

            if (qr && session) {
                try {
                    // Generate QR code image
                    const qrImage = await qrcode.toBuffer(qr);
                    
                    // Create inline keyboard for cancel button
                    const cancelButton = {
                        inline_keyboard: [[
                            { text: '❌ Cancel Connection', callback_data: `cancel_${userId}` }
                        ]]
                    };

                    // If there's an existing QR message, edit it. Otherwise, send new
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
                    
                    // If we have a QR message, edit it
                    if (session.qrMsg) {
                        await bot.editMessageCaption('✅ WhatsApp Connected Successfully!', {
                            chat_id: msg.chat.id,
                            message_id: session.qrMsg.message_id
                        }).catch(console.error);
                    }

                    // Get user info
                    const userInfo = sock.user;
                    await bot.sendMessage(msg.chat.id, 
                        `📱 *Connected WhatsApp Account* ✅\n` +
                        `• Number: ${userInfo.id.split(':')[0]}\n` +
                        `• Name: ${userInfo.name}\n` +
                        `• Device: ${userInfo.platform}\n\n` +
                        `Use /link to get group invite links 👀\n` +
                        `Use /logout to disconnect WhatsApp 💡\n\n` +
                        `${WATERMARK}`,
                        { parse_mode: 'Markdown' }
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
                        // User logged out or connection closed after successful connection
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

        // Save credentials on update
        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        await bot.sendMessage(msg.chat.id,
            `❌ Error connecting to WhatsApp\nPlease try again later\n\n${WATERMARK}`
        ).catch(console.error);
    }
}

// Handle /start command
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
        // Get groups with retry
        let groups;
        for (let i = 0; i < 3; i++) {
            try {
                groups = await session.sock.groupFetchAllParticipating();
                if (groups) break;
            } catch (err) {
                console.error('Retry fetching groups:', err);
                if (i === 2) throw err;
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!groups) {
            throw new Error('Failed to fetch groups after retries');
        }

        const groupEntries = Object.entries(groups);
        let results = [];
        let processedCount = 0;

        // Process each group
        for (const [groupId, groupInfo] of groupEntries) {
            processedCount++;
            
            // Update status every few groups
            if (processedCount % 5 === 0) {
                try {
                    await bot.editMessageText(
                        `🔄 Getting group links...\nProcessed: ${processedCount}/${groupEntries.length}\n\n${WATERMARK}`, {
                        chat_id: msg.chat.id,
                        message_id: statusMsg.message_id
                    }).catch(() => {});
                } catch (err) {
                    console.error('Error updating status:', err);
                }
            }

            try {
                // Get invite code with retry
                let inviteCode;
                for (let i = 0; i < 3; i++) {
                    try {
                        inviteCode = await session.sock.groupInviteCode(groupId);
                        if (inviteCode) break;
                    } catch (err) {
                        console.error('Retry getting invite code:', err);
                        if (i === 2) throw err;
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }

                if (inviteCode) {
                    results.push({
                        name: groupInfo.subject || 'Unknown Group',
                        link: `https://chat.whatsapp.com/${inviteCode}`
                    });
                }

                // Longer delay between requests to avoid rate limiting
                await new Promise(r => setTimeout(r, 5000));
                
            } catch (err) {
                console.error(`Failed to get invite code for group ${groupInfo.subject}:`, err);
                continue;
            }
        }

        // Sort by name
        results.sort((a, b) => a.name.localeCompare(b.name));

        // Create simple report
        let fileContent = '📱 WhatsApp Group Links\n\n';
        
        for (const group of results) {
            fileContent += `Group: ${group.name}\n`;
            fileContent += `Link: ${group.link}\n\n`;
        }
        
        fileContent += `\nTotal Groups Found: ${results.length}\n`;
        fileContent += WATERMARK;

        // Save and send report
        const fileName = `groups_${Date.now()}.txt`;
        fs.writeFileSync(fileName, fileContent);
        
        await bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
        await bot.sendDocument(msg.chat.id, fileName, {
            caption: `✅ Found ${results.length} group links\n\n${WATERMARK}`
        });
        
        fs.unlinkSync(fileName);

    } catch (error) {
        console.error('Error:', error);
        try {
            await bot.editMessageText(
                `❌ Error getting group links. Please try again.\n\n${WATERMARK}`, {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id
            });
        } catch (err) {
            await bot.sendMessage(msg.chat.id, 
                `❌ Error getting group links. Please try again.\n\n${WATERMARK}`
            );
        }
    }
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;

    if (action.startsWith('start_session_')) {
        // Check if user already has an active session
        if (hasActiveSession(userId)) {
            await bot.editMessageText(
                `❌ You already have an active WhatsApp session\nPlease use /logout first to start a new session\n\n${WATERMARK}`, {
                chat_id: msg.chat.id,
                message_id: msg.message_id
            });
            return;
        }

        await bot.editMessageText('🔄 Initializing WhatsApp connection...', {
            chat_id: msg.chat.id,
            message_id: msg.message_id
        });
        
        // Check if there's an existing session folder
        if (hasExistingSession(userId)) {
            try {
                // Try to restore existing session
                connectToWhatsApp(userId, msg);
            } catch (error) {
                console.error('Error restoring session:', error);
                // If restore fails, delete the session folder and start fresh
                const sessionPath = createSessionFolder(userId);
                fs.rmSync(sessionPath, { recursive: true, force: true });
                connectToWhatsApp(userId, msg);
            }
        } else {
            connectToWhatsApp(userId, msg);
        }
    }
    
    if (action.startsWith('cancel_')) {
        const session = sessions.get(userId);
        if (session && session.sock) {
            try {
                await session.sock.logout();
                await session.sock.end();
                
                // Delete session files
                const sessionPath = createSessionFolder(userId);
                fs.rmSync(sessionPath, { recursive: true, force: true });
                
                sessions.delete(userId);
                
                await bot.editMessageCaption(
                    `❌ Connection cancelled\n\n${WATERMARK}`, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id
                });
            } catch (error) {
                console.error('Error cancelling connection:', error);
                await bot.editMessageCaption(
                    `❌ Error cancelling connection\n\n${WATERMARK}`, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id
                });
            }
        }
    }
});

// Error handling for bot
bot.on('error', (error) => {
    console.error('Telegram Bot Error:', error);
});

// Handle polling errors
bot.on('polling_error', (error) => {
    console.error('Polling Error:', error);
});

// Clean up function for handling process termination
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
