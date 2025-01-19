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
const token = 'YOUR_BOT_TOKEN';
const bot = new TelegramBot(token, { polling: true });

// Authorized Users
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Store Management
const sessions = new Map();
const qrMessages = new Map();
const userStates = new Map();

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
                                '1️⃣ Open WhatsApp on your phone\n' +
                                '2️⃣ Tap Menu or Settings and select *WhatsApp Web*\n' +
                                '3️⃣ Point your phone camera to this QR code\n\n' +
                                '⚠️ QR code will expire in 30 seconds',
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '❌ Cancel Connection', callback_data: 'cancel_login' }
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
                    await bot.sendMessage(userId, '🔄 Reconnecting to WhatsApp...\n\nPlease wait...');
                    connectToWhatsApp(userId);
                } else {
                    await bot.sendMessage(userId, '📴 WhatsApp session logged out', {
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
                
                if (qrMessages.has(userId)) {
                    try {
                        await bot.deleteMessage(userId, qrMessages.get(userId));
                        qrMessages.delete(userId);
                    } catch (err) {
                        console.log('QR message deletion error:', err);
                    }
                }

                await bot.sendMessage(userId, '✅ *WhatsApp Connected Successfully!*\n\n' +
                    'Choose an action from the menu below:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Create New Group', callback_data: 'create_group' },
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
        await bot.sendMessage(userId, '❌ WhatsApp connection error. Please try again.');
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
            // Extract phone number
            let number = line.split(':')[1];
            if (number) {
                // Clean the number
                number = number.replace(/[^0-9]/g, '');
                
                // Handle different number formats
                if (number.startsWith('0')) {
                    number = '62' + number.substring(1);
                } else if (!number.startsWith('62') && !number.startsWith('+')) {
                    number = '62' + number;
                } else if (number.startsWith('+')) {
                    number = number.substring(1);
                }
                
                // Add WhatsApp suffix
                const waNumber = number + '@s.whatsapp.net';
                if (!contacts.includes(waNumber)) {
                    contacts.push(waNumber);
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

// Start command handler
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuthorization(userId, msg)) return;
    
    await bot.sendMessage(userId, '👋 *Welcome to WhatsApp Group Manager!*\n\n' +
        'This bot helps you create WhatsApp groups from VCF contact files.\n\n' +
        'Choose an option to begin:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
            ]]
        }
    });
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    if (!await checkAuthorization(userId, callbackQuery.message)) return;
    
    const data = callbackQuery.data;

    switch (data) {
        case 'connect':
            await bot.sendMessage(userId, '🔄 *Initiating WhatsApp Connection*\n\nPlease wait...', {
                parse_mode: 'Markdown'
            });
            connectToWhatsApp(userId);
            break;
            
        case 'cancel_login':
            if (qrMessages.has(userId)) {
                await bot.deleteMessage(userId, qrMessages.get(userId));
                qrMessages.delete(userId);
            }
            await bot.sendMessage(userId, '❌ Connection cancelled\n\nChoose an option:', {
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
                    await bot.sendMessage(userId, '✅ *Successfully logged out from WhatsApp*\n\n' +
                        'Choose an option to continue:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                            ]]
                        }
                    });
                } catch (error) {
                    console.error('Logout error:', error);
                    await bot.sendMessage(userId, '❌ Error during logout. Please try again.');
                }
            }
            break;
            
        case 'create_group':
            const waSocket = sessions.get(userId);
            if (!waSocket) {
                await bot.sendMessage(userId, '❌ *WhatsApp is not connected!*\n\n' +
                    'Please connect to WhatsApp first:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                        ]]
                    }
                });
                return;
            }
            
            await bot.sendMessage(userId, '📁 *Send VCF Contact File*\n\n' +
                '1. Export contacts from your phone as VCF file\n' +
                '2. Send the VCF file here\n' +
                '3. Wait for processing\n\n' +
                '⚠️ Make sure all numbers are valid WhatsApp numbers', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_vcf');
            break;
            
        case 'confirm_contacts':
            await bot.sendMessage(userId, '✏️ *Enter Group Name*\n\n' +
                'Please send the name for your new WhatsApp group.\n\n' +
                '⚠️ Group name must be between 1-25 characters', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_group_name');
            break;
            
        case 'cancel_group':
            userStates.delete(userId);
            sessions.delete(userId + '_contacts');
            
            await bot.sendMessage(userId, '❌ Group creation cancelled\n\n' +
                'Choose an option:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '📱 Create New Group', callback_data: 'create_group' },
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
        await bot.sendMessage(userId, '❌ WhatsApp is not connected!');
        return;
    }

    try {
        const processingMsg = await bot.sendMessage(userId, '⏳ Processing VCF file...');
        
        const file = await bot.getFile(msg.document.file_id);
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        const vcfContent = await response.text();
        
        const contacts = parseVCF(vcfContent);
        
        if (contacts.length === 0) {
            await bot.editMessageText('❌ No valid contacts found in VCF file.\n\nPlease check the file and try again.', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            return;
        }
        
        sessions.set(userId + '_contacts', contacts);
        
        const confirmMessage = `📋 *Contact Processing Complete*\n\n` +
            `📱 Total Contacts Found: ${contacts.length}\n\n` +
            `Please confirm to continue:`;
            
        await bot.editMessageText(confirmMessage, {
            chat_id: userId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
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
        await bot.sendMessage(userId, '❌ Error processing VCF file.\n\nPlease check the file format and try again.');
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
        await bot.sendMessage(userId, '❌ *Error:* Group name too long!\n\n' +
            'Please send a shorter name (max 25 characters)', {
            parse_mode: 'Markdown'
        });
        return;
    }
    
    try {
        const statusMsg = await bot.sendMessage(userId, 
            '⏳ *Creating WhatsApp Group*\n\n' +
            '• Preparing contacts...\n' +
            '• Initializing group...\n' +
            '• Adding members...\n\n' +
            'Please wait...', {
            parse_mode: 'Markdown'
        });
        
        // Create group
        const group = await sock.groupCreate(groupName, contacts);
        
        if (group.status) {
            try {
                // Get group metadata
                const groupInfo = await sock.groupMetadata(group.id);
                const successfulMembers = groupInfo.participants.length;
                const failedMembers = contacts.length - successfulMembers;
                
                // Calculate success rate
                const successRate = ((successfulMembers / contacts.length) * 100).toFixed(1);
                
                // Format group ID for display
                const displayGroupId = group.id.split('@')[0];
                
                // Create detailed success message
                const successMessage = `✅ *WhatsApp Group Created Successfully!*\n\n` +
                    `📱 *Group Details:*\n` +
                    `• Name: ${groupName}\n` +
                    `• ID: ${displayGroupId}\n\n` +
                    `👥 *Member Statistics:*\n` +
                    `• Total Contacts: ${contacts.length}\n` +
                    `• Successfully Added: ${successfulMembers}\n` +
                    `• Failed to Add: ${failedMembers}\n` +
                    `• Success Rate: ${successRate}%\n\n` +
                    (failedMembers > 0 ? 
                        `ℹ️ *Note:* Some members couldn't be added due to:\n` +
                        `• Invalid phone numbers\n` +
                        `• Numbers not on WhatsApp\n` +
                        `• Privacy settings\n` +
                        `• Other WhatsApp restrictions\n\n` : 
                        `🌟 *Perfect! All members were added successfully!*\n\n`) +
                    `Choose your next action:`;

                await bot.editMessageText(successMessage, {
                    chat_id: userId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Create Another Group', callback_data: 'create_group' },
                            { text: '🚪 Logout', callback_data: 'logout' }
                        ]]
                    }
                });

                // Clear states
                userStates.delete(userId);
                sessions.delete(userId + '_contacts');
            } catch (metadataError) {
                console.error('Error getting group metadata:', metadataError);
                throw new Error('Failed to get group information');
            }
        } else {
            throw new Error('Group creation failed');
        }
        
    } catch (error) {
        console.error('Group creation error:', error);
        await bot.sendMessage(userId, 
            '❌ *Error Creating Group*\n\n' +
            'Failed to create WhatsApp group.\n' +
            'Please try again or contact support.\n\n' +
            'Common issues:\n' +
            '• Network connection problems\n' +
            '• WhatsApp server issues\n' +
            '• Invalid contact numbers\n\n' +
            'Choose an option:', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Try Again', callback_data: 'create_group' },
                    { text: '🚪 Logout', callback_data: 'logout' }
                ]]
            }
        });
    }
});
