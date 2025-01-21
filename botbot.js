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
const path = require('path');

// Bot Configuration
const token = '7711523807:AAFB_TTpeR1Hz8wVcQcpz6yu6cLXeLBIs8c';
const bot = new TelegramBot(token, { polling: true });

// Authorized Users
const AUTHORIZED_USERS = [6022261644, 5988451717];

// Store Management with better memory management
const sessions = new Map();
const qrMessages = new Map();
const userStates = new Map();
const tempData = new Map();

// Fixed session path handling
const SESSION_DIR = './wa_sessions';

// Helper untuk delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Initialize session directory
async function initSession() {
    try {
        await fs.mkdir(SESSION_DIR, { recursive: true });
    } catch (error) {
        console.error('Session directory init error:', error);
    }
}

// Get session path for user
function getSessionPath(userId) {
    return path.join(SESSION_DIR, `session_${userId}`);
}

// Improved getGroupInviteLink dengan rate limiting handling
async function getGroupInviteLink(sock, jid, retryCount = 0) {
    try {
        const metadata = await sock.groupMetadata(jid);
        
        // Verify bot's admin status
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const participant = metadata.participants.find(p => p.id === botId);
        
        if (!participant?.admin) {
            throw new Error('Bot is not admin');
        }

        // Add delay before getting invite code to avoid rate limit
        await delay(1000 * (retryCount + 1)); // Increasing delay for each retry
        
        try {
            const inviteCode = await sock.groupInviteCode(jid);
            return `https://chat.whatsapp.com/${inviteCode}`;
        } catch (error) {
            if (error.message.includes('rate-overlimit') && retryCount < 3) {
                // Wait longer and retry if rate limited
                await delay(3000 * (retryCount + 1));
                return getGroupInviteLink(sock, jid, retryCount + 1);
            }
            throw error;
        }
    } catch (error) {
        throw new Error(`Failed to get link: ${error.message}`);
    }
}

// Fixed authorization check
async function checkAuth(userId, msg) {
    if (!AUTHORIZED_USERS.includes(userId)) {
        await bot.sendMessage(msg.chat.id, '⛔ Access denied.');
        return false;
    }
    return true;
}

// Completely rebuilt WhatsApp connection handler
async function connectToWhatsApp(userId) {
    const sessionPath = getSessionPath(userId);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            logger: pino({ level: 'silent' }),
            browser: ["Chrome (Linux)", "Desktop", "1.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            markOnlineOnConnect: false
        });

        // Enhanced connection handling
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrImage = await QRCode.toBuffer(qr);
                    
                    // Clean up previous QR
                    if (qrMessages.has(userId)) {
                        try {
                            await bot.deleteMessage(userId, qrMessages.get(userId));
                        } catch (err) {
                            console.error('QR cleanup error:', err);
                        }
                    }

                    const msg = await bot.sendPhoto(userId, qrImage, {
                        caption: '📱 *Scan QR Code*\n\n' +
                                '1️⃣ Open WhatsApp\n' +
                                '2️⃣ Go to Settings > WhatsApp Web\n' +
                                '3️⃣ Scan this QR code\n\n' +
                                '⚠️ QR expires in 20 seconds',
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '❌ Cancel', callback_data: 'cancel_login' }
                            ]]
                        }
                    });
                    
                    qrMessages.set(userId, msg.message_id);
                } catch (err) {
                    console.error('QR error:', err);
                    await bot.sendMessage(userId, '❌ QR generation failed. Please try again.');
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
                    lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('Reconnecting...');
                    await bot.sendMessage(userId, '🔄 Connection lost. Reconnecting...');
                    setTimeout(() => connectToWhatsApp(userId), 3000);
                } else {
                    console.log('Connection closed');
                    await bot.sendMessage(userId, '📴 Session ended', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Reconnect', callback_data: 'connect' }
                            ]]
                        }
                    });
                    sessions.delete(userId);
                    await clearSession(userId);
                }
            }

            if (connection === 'open') {
                sessions.set(userId, sock);
                
                // Clean up QR message
                if (qrMessages.has(userId)) {
                    try {
                        await bot.deleteMessage(userId, qrMessages.get(userId));
                        qrMessages.delete(userId);
                    } catch (err) {
                        console.error('QR cleanup error:', err);
                    }
                }

                await bot.sendMessage(userId, '✅ *WhatsApp Connected!*\n\n' +
                    'Choose an action:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Create Group', callback_data: 'create_group' },
                            { text: '🔗 Get Links', callback_data: 'get_links' }
                        ],
                        [
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
        await bot.sendMessage(userId, '❌ Connection failed. Please try again.');
        return null;
    }
}

// Improved session clearing
async function clearSession(userId) {
    try {
        const sessionPath = getSessionPath(userId);
        await fs.rm(sessionPath, { recursive: true, force: true });
        sessions.delete(userId);
        qrMessages.delete(userId);
        userStates.delete(userId);
        tempData.delete(userId);
    } catch (error) {
        console.error('Session clearing error:', error);
        throw error;
    }
}

// Fixed VCF parsing
function parseVCF(content) {
    const contacts = new Set();
    const lines = content.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith('TEL')) {
            let number = trimmed.split(':')[1]?.replace(/[^0-9+]/g, '');
            if (!number) continue;

            // Format number
            if (number.startsWith('+62')) {
                number = number.substring(1);
            } else if (number.startsWith('0')) {
                number = '62' + number.substring(1);
            } else if (!number.startsWith('62')) {
                number = '62' + number;
            }

            // Validate number
            if (number.length >= 10 && number.length <= 15) {
                contacts.add(number + '@s.whatsapp.net');
            }
        }
    }
    
    return Array.from(contacts);
}

// Improved group creation with better connection handling
async function createGroup(sock, name, participants, maxRetries = 3) {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Check connection before attempting
            if (!sock.user || !sock.user.id) {
                throw new Error('No WhatsApp connection');
            }

            // Add delay before creation
            await delay(2000 * (attempt + 1));

            // Verify connection state
            const connectionState = await sock.connectionState;
            if (connectionState !== 'open') {
                throw new Error('Connection not ready');
            }

            // Split participants if more than 20
            const maxParticipantsPerBatch = 20;
            const participantBatches = [];
            
            for (let i = 0; i < participants.length; i += maxParticipantsPerBatch) {
                participantBatches.push(participants.slice(i, i + maxParticipantsPerBatch));
            }

            // Create group with first batch
            const group = await sock.groupCreate(name, participantBatches[0], {
                timeout: 60000 // 60 seconds timeout
            });

            if (!group || !group.id) {
                throw new Error('Group creation failed');
            }

            // Wait for group to be properly created
            await delay(3000);

            // Add remaining participants in batches
            if (participantBatches.length > 1) {
                for (let i = 1; i < participantBatches.length; i++) {
                    try {
                        await sock.groupParticipantsUpdate(
                            group.id,
                            participantBatches[i].map(p => p.id),
                            "add"
                        );
                        await delay(2000); // Wait between batches
                    } catch (batchError) {
                        console.error(`Batch ${i + 1} add error:`, batchError);
                        continue; // Continue with next batch if one fails
                    }
                }
            }

            // Verify group exists
            const metadata = await sock.groupMetadata(group.id);
            if (!metadata) {
                throw new Error('Failed to verify group creation');
            }

            return group;

        } catch (error) {
            console.error(`Group creation attempt ${attempt + 1} failed:`, error);

            // Handle specific errors
            if (error.output?.statusCode === 408 || error.message.includes('Timed Out')) {
                await delay(5000 * (attempt + 1)); // Increased delay for timeout
            }
            
            if (error.message.includes('Connection Closed') || error.message.includes('Connection not ready')) {
                // Try to recover connection
                await delay(3000);
                try {
                    await sock.connect();
                    await delay(2000);
                } catch (connectError) {
                    console.error('Reconnection failed:', connectError);
                }
            }

            // Throw on last attempt
            if (attempt === maxRetries - 1) {
                throw error;
            }
        }
    }
}

// Command handlers
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuth(userId, msg)) return;
    
    await bot.sendMessage(userId, '👋 *Welcome!*\n\n' +
        'Choose an option:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
            ]]
        }
    });
});

// Fixed getlink command with rate limit handling
bot.onText(/\/getlink/, async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuth(userId, msg)) return;
    
    const sock = sessions.get(userId);
    if (!sock) {
        await bot.sendMessage(userId, '❌ Not connected!\n\nPlease connect first:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                ]]
            }
        });
        return;
    }

    try {
        const statusMsg = await bot.sendMessage(userId, '🔍 Fetching groups...');
        const groups = await sock.groupFetchAllParticipating();
        
        if (!groups || Object.keys(groups).length === 0) {
            await bot.editMessageText('❌ No groups found!', {
                chat_id: userId,
                message_id: statusMsg.message_id
            });
            return;
        }

        let responseText = '📋 *Your Groups:*\n\n';
        let count = 0;
        let messageParts = [];
        const groupEntries = Object.entries(groups);

        // Process groups in chunks to avoid rate limit
        for (let i = 0; i < groupEntries.length; i++) {
            const [jid, group] = groupEntries[i];
            try {
                count++;
                let groupText = `*${count}. ${group.subject}*\n`;
                
                // Add delay between each group processing
                await delay(1500); // 1.5 second delay between each group
                
                const link = await getGroupInviteLink(sock, jid);
                groupText += `🔗 ${link}\n\n`;

                // Split into parts if too long
                if ((responseText + groupText).length > 3000) {
                    messageParts.push(responseText);
                    responseText = groupText;
                } else {
                    responseText += groupText;
                }

                // Update status message every 5 groups
                if (i % 5 === 0) {
                    await bot.editMessageText(
                        `🔄 Fetching group links...\n\nProcessed: ${i + 1}/${groupEntries.length} groups`, {
                        chat_id: userId,
                        message_id: statusMsg.message_id
                    }).catch(console.error);
                }

            } catch (error) {
                console.error(`Error processing group ${group.subject}:`, error);
                responseText += `*${count}. ${group.subject}*\n❌ ${error.message}\n\n`;
                
                // Add extra delay if rate limited
                if (error.message.includes('rate-overlimit')) {
                    await delay(5000); // 5 seconds delay after rate limit
                }
            }
        }

        // Send remaining text
        if (responseText) {
            messageParts.push(responseText);
        }

        // Delete status message
        await bot.deleteMessage(userId, statusMsg.message_id).catch(console.error);

        // Send all parts
        for (const part of messageParts) {
            await bot.sendMessage(userId, part, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
            await delay(1000); // Delay between sending messages
        }

    } catch (error) {
        console.error('Get links error:', error);
        await bot.sendMessage(userId, '❌ Failed to fetch groups. Please try again.');
    }
});

// Improved callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    if (!await checkAuth(userId, callbackQuery.message)) return;
    
    const data = callbackQuery.data;

    switch (data) {
        case 'connect':
            await bot.sendMessage(userId, '🔄 Starting WhatsApp connection...');
            await connectToWhatsApp(userId);
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
                    // Properly close the connection
                    await sock.logout();
                    await clearSession(userId);
                    
                    await bot.sendMessage(userId, '✅ Successfully logged out\n\n' +
                        'Choose an option:', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                            ]]
                        }
                    });
                } catch (error) {
                    console.error('Logout error:', error);
                    await bot.sendMessage(userId, '❌ Logout failed. Please try again.');
                }
            }
            break;
            
        case 'get_links':
            // Trigger getlink command
            await bot.emit('text', { 
                text: '/getlink', 
                from: { id: userId },
                chat: { id: userId }
            });
            break;
            
        case 'create_group':
            const waSocket = sessions.get(userId);
            if (!waSocket) {
                await bot.sendMessage(userId, '❌ Not connected!\n\nPlease connect first:', {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔄 Connect WhatsApp', callback_data: 'connect' }
                        ]]
                    }
                });
                return;
            }
            
            await bot.sendMessage(userId, '📁 *Send VCF File*\n\n' +
                '1. Export contacts as VCF\n' +
                '2. Send the file here\n' +
                '3. Wait for processing\n\n' +
                '⚠️ Ensure all numbers are valid WhatsApp numbers', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_vcf');
            break;
            
        case 'confirm_contacts':
            await bot.sendMessage(userId, '✏️ *Enter Group Name*\n\n' +
                'Send a name for your new WhatsApp group.\n\n' +
                '⚠️ Name must be 1-25 characters', {
                parse_mode: 'Markdown'
            });
            userStates.set(userId, 'waiting_group_name');
            break;
            
        case 'cancel_group':
            userStates.delete(userId);
            tempData.delete(userId);
            
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
    if (!await checkAuth(userId, msg)) return;
    
    const state = userStates.get(userId);
    if (state !== 'waiting_vcf') return;
    
    const sock = sessions.get(userId);
    if (!sock) {
        await bot.sendMessage(userId, '❌ WhatsApp not connected!');
        return;
    }

    try {
        const processingMsg = await bot.sendMessage(userId, 
            '⏳ *Processing VCF File*\n\n' +
            '• Reading file...\n' +
            '• Validating contacts...\n' +
            '• Preparing list...\n\n' +
            'Please wait...', {
            parse_mode: 'Markdown'
        });
        
        const file = await bot.getFile(msg.document.file_id);
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        const vcfContent = await response.text();
        
        const contacts = parseVCF(vcfContent);
        
        if (contacts.length === 0) {
            await bot.editMessageText('❌ No valid contacts found.\n\nPlease check the file and try again.', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            return;
        }
        
        tempData.set(userId, contacts);
        
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
        await bot.sendMessage(userId, '❌ Failed to process VCF file.\n\nPlease check the format and try again.');
    }
});

// Enhanced group creation handler
bot.on('text', async (msg) => {
    const userId = msg.from.id;
    if (!await checkAuth(userId, msg)) return;
    
    const state = userStates.get(userId);
    if (state !== 'waiting_group_name') return;
    
    const sock = sessions.get(userId);
    if (!sock) {
        await bot.sendMessage(userId, '❌ WhatsApp connection lost.\n\nPlease reconnect:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Reconnect', callback_data: 'connect' }
                ]]
            }
        });
        return;
    }

    const contacts = tempData.get(userId);
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        await bot.sendMessage(userId, '❌ Contact data not found.\n\nPlease start over:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📱 Create Group', callback_data: 'create_group' }
                ]]
            }
        });
        return;
    }

    const groupName = msg.text.trim();
    
    if (!groupName || groupName.length > 25) {
        await bot.sendMessage(userId, '❌ *Error:* Invalid group name!\n\n' +
            'Please send a name between 1-25 characters.', {
            parse_mode: 'Markdown'
        });
        return;
    }
    
    try {
        const statusMsg = await bot.sendMessage(userId, 
            '⏳ *Creating WhatsApp Group*\n\n' +
            '• Checking connection...\n' +
            '• Preparing participants...\n' +
            '• Creating group...\n\n' +
            'Please wait...', {
            parse_mode: 'Markdown'
        });

        // Format and validate participants
        const validParticipants = contacts
            .filter(id => id && typeof id === 'string' && id.includes('@s.whatsapp.net'))
            .map(id => ({
                id: id,
                admin: false // Set all participants as regular members
            }));

        if (validParticipants.length === 0) {
            throw new Error('No valid participants found');
        }

        // Create group with improved error handling
        const group = await createGroup(sock, groupName, validParticipants);

        if (group && group.id) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                const groupInfo = await sock.groupMetadata(group.id);
                const successfulMembers = groupInfo.participants.length - 1; // Subtract 1 for the bot
                const failedMembers = contacts.length - successfulMembers;
                const successRate = ((successfulMembers / contacts.length) * 100).toFixed(1);
                
                let successMessage = `✅ *WhatsApp Group Created!*\n\n` +
                    `📱 *Group Details:*\n` +
                    `• Name: ${groupName}\n` +
                    `• ID: ${group.id.split('@')[0]}\n\n` +
                    `👥 *Member Statistics:*\n` +
                    `• Total Contacts: ${contacts.length}\n` +
                    `• Successfully Added: ${successfulMembers}\n` +
                    `• Failed to Add: ${failedMembers}\n` +
                    `• Success Rate: ${successRate}%\n\n`;

                if (failedMembers > 0) {
                    successMessage += `ℹ️ *Note:* Some members couldn't be added due to:\n` +
                        `• Invalid numbers\n` +
                        `• Not registered on WhatsApp\n` +
                        `• Privacy settings\n` +
                        `• Other WhatsApp limitations\n\n`;
                } else {
                    successMessage += `🌟 *Perfect! All members added successfully!*\n\n`;
                }

                // Try to get group link
                try {
                    const link = await getGroupInviteLink(sock, group.id);
                    successMessage += `🔗 *Invite Link:*\n${link}\n\n`;
                } catch (linkError) {
                    console.error('Link generation error:', linkError);
                    successMessage += `⚠️ Unable to generate invite link. Please create manually.\n\n`;
                }

                successMessage += `Choose your next action:`;

                await bot.editMessageText(successMessage, {
                    chat_id: userId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📱 Create Another Group', callback_data: 'create_group' },
                            { text: '🚪 Logout', callback_data: 'logout' }
                        ]]
                    }
                });

                // Clean up
                userStates.delete(userId);
                tempData.delete(userId);
                
            } catch (metadataError) {
                console.error('Metadata error:', metadataError);
                throw new Error('Failed to get group information');
            }
        } else {
            throw new Error('Group creation failed');
        }
        
    } catch (error) {
        console.error('Group creation error:', error);
        await bot.sendMessage(userId, 
            '❌ *Group Creation Failed*\n\n' +
            `Error: ${error.message}\n\n` +
            'Please verify:\n' +
            '• WhatsApp connection is stable\n' +
            '• All numbers are valid\n' +
            '• You have permission to add members\n\n' +
            'Choose an option:', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔄 Try Again', callback_data: 'create_group' },
                    { text: '🔄 Reconnect', callback_data: 'connect' }
                ]]
            }
        });
    }
});

// Initialize the bot
(async () => {
    try {
        await initSession();
        console.log('Bot started successfully');
    } catch (error) {
        console.error('Bot initialization error:', error);
    }
})();
