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
const TELEGRAM_TOKEN = '7711523807:AAE_VG5Su-U24cnuuMuPjcadYd86pAOCfNI';

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

// Logout function
async function logoutWhatsApp(userId, chatId) {
    const session = sessions.get(userId);
    if (session && session.sock) {
        try {
            await session.sock.logout();
            await session.sock.end();
            
            // Delete session files
            const sessionPath = createSessionFolder(userId);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            
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

// WhatsApp connection function
async function connectToWhatsApp(userId, msg) {
    try {
        const sessionPath = createSessionFolder(userId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Initialize WhatsApp client with improved configuration
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

// Enhanced group link retrieval
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
        // Get all groups with retry mechanism
        const getGroups = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    const groups = await session.sock.groupFetchAllParticipating();
                    return groups;
                } catch (err) {
                    if (i === retries - 1) throw err;
                    await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
                }
            }
        };

        const groups = await getGroups();
        if (!groups || Object.keys(groups).length === 0) {
            await bot.editMessageText(
                `ℹ️ No groups found in your WhatsApp account.\n\n${WATERMARK}`, {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id
            });
            return;
        }

        const groupEntries = Object.entries(groups);
        let results = [];
        let failedGroups = [];

        // Process groups with improved error handling
        for (const [groupId, groupInfo] of groupEntries) {
            try {
                // Retry mechanism for invite code
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
            
            // Delay between requests to prevent rate limiting
            await new Promise(r => setTimeout(r, 1000));
        }

        // Sort groups by name
        results.sort((a, b) => a.name.localeCompare(b.name));

        // Create detailed report
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

        // Save and send report
        const fileName = `whatsapp_groups_${Date.now()}.txt`;
        fs.writeFileSync(fileName, fileContent);
        
        await bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
        await bot.sendDocument(msg.chat.id, fileName, {
            caption: `✅ Retrieved ${results.length} group links\n` +
                    `${failedGroups.length > 0 ? `❌ Failed: ${failedGroups.length}\n` : ''}` +
                    `📊 Total Groups: ${groupEntries.length}\n\n${WATERMARK}`
        });
        
        fs.unlinkSync(fileName);

    } catch (error) {
        console.error('Error in group link retrieval:', error);
        await bot.editMessageText(
            `❌ Error getting group links. Please try again.\n\n${WATERMARK}`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id
        }).catch(async () => {
            await bot.sendMessage(msg.chat.id, 
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

// Rest of the code remains the same (callback handling, error handling, etc.)

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
