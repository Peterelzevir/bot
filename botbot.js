// index.js
const TelegramBot = require('node-telegram-bot-api');
const { 
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    getAggregateVotesInPollMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs');
const vcf = require('vcf');
const pino = require('pino');
const { promisify } = require('util');
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

// Replace with your bot token
const token = '7711523807:AAFu5Qn6rBWZ5JPHWdM_afApyNsaieIAHDQ';
const bot = new TelegramBot(token, { polling: true });

// Store user sessions and states
const sessions = new Map();
const qrMessages = new Map();
const userStates = new Map();

// Authorized users
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Authorization check function
async function checkAuthorization(userId, msg) {
    if (!AUTHORIZED_USERS.includes(userId)) {
        await bot.sendMessage(msg.chat.id, 'Access Denied. You are not authorized to use this bot.');
        return false;
    }
    return true;
}

// Function to create robust WhatsApp connection
async function connectToWhatsApp(userId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(`Hiyaok Create`);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            generateHighQualityLinkPreview: true,
            logger: pino({ level: 'silent' }),
            msgRetryCounterCache: {},
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            emitOwnEvents: true,
            fireInitQueries: true,
            downloadHistory: false,
            syncFullHistory: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrImage = await qrcode.toBuffer(qr);
                    
                    if (qrMessages.has(userId)) {
                        try {
                            await bot.deleteMessage(userId, qrMessages.get(userId));
                        } catch (err) {
                            console.log('Error deleting previous QR:', err);
                        }
                    }

                    const msg = await bot.sendPhoto(userId, qrImage, {
                        caption: 'Scan this QR code to login WhatsApp\nQR will expire in 30 seconds',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '❌ Cancel Connection', callback_data: 'cancel_login' }
                            ]]
                        }
                    });
                    
                    qrMessages.set(userId, msg.message_id);
                } catch (err) {
                    console.error('QR generation error:', err);
                    await bot.sendMessage(userId, 'Error generating QR code. Please try again.');
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)? 
                    lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
                
                if (shouldReconnect) {
                    await bot.sendMessage(userId, 'Reconnecting to WhatsApp...');
                    connectToWhatsApp(userId);
                } else {
                    await bot.sendMessage(userId, 'WhatsApp session logged out', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Connect Again', callback_data: 'connect' }
                            ]]
                        }
                    });
                    sessions.delete(userId);
                    await clearSession(userId);
                }
            }

            if (connection === 'open') {
                sessions.set(userId, sock);
                await bot.sendMessage(userId, 'WhatsApp connected successfully!', {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Create Group', callback_data: 'create_group' },
                            { text: '🚪 Logout', callback_data: 'logout' }
                        ]]
                    }
                });
                
                if (qrMessages.has(userId)) {
                    try {
                        await bot.deleteMessage(userId, qrMessages.get(userId));
                        qrMessages.delete(userId);
                    } catch (err) {
                        console.log('Error deleting QR message:', err);
                    }
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        // Handle messages
        sock.ev.on('messages.upsert', async (m) => {
            console.log('New message:', m);
        });

        // Handle groups
        sock.ev.on('groups.upsert', async (groups) => {
            console.log('Group update:', groups);
        });

        // Handle group participants
        sock.ev.on('group-participants.update', async (participants) => {
            console.log('Participants update:', participants);
        });
        
        return sock;
    } catch (error) {
        console.error('Connection error:', error);
        await bot.sendMessage(userId, 'Error connecting to WhatsApp. Please try again.');
        return null;
    }
}

// Clear session data
async function clearSession(userId) {
    try {
        const sessionPath = `Hiyaok Create`;
        if (fs.existsSync(sessionPath)) {
            await unlinkAsync(sessionPath);
        }
    } catch (error) {
        console.error('Error clearing session:', error);
    }
}

// Start command handler
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    if (!sessions.has(userId)) {
        await bot.sendMessage(userId, 'Welcome! Please select an option:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                ]]
            }
        });
    } else {
        await bot.sendMessage(userId, 'WhatsApp is connected! Choose an action:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📱 Create Group', callback_data: 'create_group' },
                    { text: '🚪 Logout', callback_data: 'logout' }
                ]]
            }
        });
    }
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    if (!await checkAuthorization(userId, callbackQuery.message)) return;
    const data = callbackQuery.data;

    switch (data) {
        case 'connect':
            await bot.sendMessage(userId, 'Initiating WhatsApp connection...');
            connectToWhatsApp(userId);
            break;
            
        case 'cancel_login':
            if (qrMessages.has(userId)) {
                await bot.deleteMessage(userId, qrMessages.get(userId));
                qrMessages.delete(userId);
            }
            await bot.sendMessage(userId, 'Connection cancelled', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
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
                    await bot.sendMessage(userId, 'Successfully logged out from WhatsApp', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                            ]]
                        }
                    });
                } catch (error) {
                    console.error('Logout error:', error);
                    await bot.sendMessage(userId, 'Error during logout. Please try again.');
                }
            }
            break;
            
        case 'create_group':
            const waSocket = sessions.get(userId);
            if (!waSocket) {
                await bot.sendMessage(userId, 'WhatsApp is not connected!', {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                        ]]
                    }
                });
                return;
            }
            
            await bot.sendMessage(userId, 'Please send the contact file (*.vcf) to create a group');
            userStates.set(userId, 'waiting_vcf');
            break;
            
        case 'confirm_contacts':
            await bot.sendMessage(userId, 'Please enter a name for the new group:');
            userStates.set(userId, 'waiting_group_name');
            break;
            
        case 'cancel_group':
            userStates.delete(userId);
            sessions.delete(userId + '_contacts');
            
            await bot.sendMessage(userId, 'Group creation cancelled', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '📱 Create Group', callback_data: 'create_group' },
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
        await bot.sendMessage(userId, 'WhatsApp is not connected!');
        return;
    }

    try {
        const file = await bot.getFile(msg.document.file_id);
        const vcfContent = await downloadFile(file.file_path);
        
        const contacts = parseVCF(vcfContent);
        sessions.set(userId + '_contacts', contacts);
        
        const statusMessage = await bot.sendMessage(userId, 
            `📋 Contact Details:\nTotal contacts: ${contacts.length}\n\nPlease confirm:`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Continue', callback_data: 'confirm_contacts' },
                    { text: '❌ Cancel', callback_data: 'cancel_group' }
                ]]
            }
        });
        
        userStates.set(userId, 'confirming_contacts');
        
    } catch (error) {
        console.error('VCF processing error:', error);
        await bot.sendMessage(userId, 'Error processing contact file. Please try again.');
    }
});

// VCF parser function
function parseVCF(content) {
    const vcard = new vcf.parse(content);
    const contacts = [];
    
    for (let card of vcard) {
        const tel = card.get('tel');
        if (tel) {
            let number = tel.valueOf().replace(/[^0-9]/g, '');
            
            // Handle international numbers
            if (number.startsWith('0')) {
                number = '62' + number.substring(1);
            } else if (!number.startsWith('62') && !number.startsWith('+')) {
                number = '62' + number;
            }
            
            contacts.push(number + '@s.whatsapp.net');
        }
    }
    
    return contacts;
}

// Group name handler
bot.on('text', async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    const state = userStates.get(userId);
    
    if (state !== 'waiting_group_name') return;
    
    const sock = sessions.get(userId);
    const contacts = sessions.get(userId + '_contacts');
    const groupName = msg.text;
    
    try {
        const statusMsg = await bot.sendMessage(userId, '⏳ Creating WhatsApp group...');
        
        // Create group with error handling
        const createGroupResponse = await sock.groupCreate(groupName, contacts, {
            timeout: 60000,
            ephemeralExpiration: 0
        });
        
        if (createGroupResponse.status === 200) {
            // Get group metadata
            const groupMetadata = await sock.groupMetadata(createGroupResponse.id);
            
            // Track successful and failed additions
            const successfulMembers = groupMetadata.participants.length;
            const failedMembers = contacts.length - successfulMembers;
            
            // Create detailed success message
            const successMessage = `✅ Group Created Successfully!\n\n` +
                `📱 Group Details:\n` +
                `• Name: ${groupName}\n` +
                `• ID: ${createGroupResponse.id}\n` +
                `• Owner: ${groupMetadata.owner}\n\n` +
                `👥 Member Statistics:\n` +
                `• Total Contacts: ${contacts.length}\n` +
                `• Successfully Added: ${successfulMembers}\n` +
                `• Failed to Add: ${failedMembers}\n\n` +
                (failedMembers > 0 ? 
                    `❗ Some members couldn't be added. Possible reasons:\n` +
                    `• Invalid phone numbers\n` +
                    `• Numbers not registered on WhatsApp\n` +
                    `• Privacy settings preventing group adds\n` : 
                    `✨ All members added successfully!`);

            await bot.editMessageText(successMessage, {
                chat_id: userId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
            
            // Add group description and settings if needed
            await sock.groupUpdateDescription(createGroupResponse.id, 'Group created via Telegram Bot');
        } else {
            throw new Error('Group creation failed');
        }
        
        // Clear states
        userStates.delete(userId);
        sessions.delete(userId + '_contacts');
        
        // Show main menu
        await bot.sendMessage(userId, 'Choose an action:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📱 Create Group', callback_data: 'create_group' },
                    { text: '🚪 Logout', callback_data: 'logout' }
                ]]
            }
        });
        
    } catch (error) {
        console.error('Group creation error:', error);
        await bot.sendMessage(userId, 'Error creating group. Please try again.');
    }
});

// Helper function to download file
async function downloadFile(filePath) {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    return await response.text();
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    for (const [userId, sock] of sessions.entries()) {
        try {
            await sock.logout();
            await clearSession(userId);
        } catch (error) {
            console.error(`Error logging out user ${userId}:`, error);
        }
    }
    process.exit(0);
});

console.log('Bot is running...');
