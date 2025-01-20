const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const vcard = require('vcard-parser');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);

    // Handle messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        
        const messageType = Object.keys(msg.message)[0];
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        // Get the message content
        let body = '';
        if (messageType === 'conversation') {
            body = msg.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            body = msg.message.extendedTextMessage.text;
        }

        // Handle commands (support multiple prefixes: ., !, #)
        const prefixes = ['.', '!', '#'];
        const prefix = prefixes.find(p => body.startsWith(p));
        if (!prefix) return;

        const command = body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase();
        const args = body.slice(prefix.length + command.length).trim();

        switch (command) {
            case 'start':
                const startMessage = `🤖 *WhatsApp Bot Commands*\n\n` +
                    `1️⃣ *${prefix}getgroups*\n` +
                    `   Get all group links\n\n` +
                    `2️⃣ *${prefix}creategroup*\n` +
                    `   Create a new group (send vcf file)\n` +
                    `   Usage: Send vcf file then use command:\n` +
                    `   ${prefix}creategroup Group Name`;
                
                await sock.sendMessage(from, { text: startMessage });
                break;

            case 'getgroups':
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let groupList = '📃 *Group List*\n\n';
                    
                    for (let group of Object.values(groups)) {
                        const groupId = group.id;
                        const groupName = group.subject;
                        const groupLink = await sock.groupInviteCode(groupId);
                        
                        groupList += `*Group:* ${groupName}\n`;
                        groupList += `*Link:* https://chat.whatsapp.com/${groupLink}\n\n`;
                    }
                    
                    await sock.sendMessage(from, { text: groupList });
                } catch (error) {
                    await sock.sendMessage(from, { text: '❌ Error fetching groups' });
                }
                break;

            case 'creategroup':
                try {
                    if (!msg.message.documentMessage) {
                        await sock.sendMessage(from, { 
                            text: '❌ Please send a VCF file first, then use the command with group name'
                        });
                        return;
                    }

                    if (!args) {
                        await sock.sendMessage(from, { 
                            text: '❌ Please provide a group name'
                        });
                        return;
                    }

                    // Download and process VCF file
                    const buffer = await downloadContentFromMessage(msg.message.documentMessage, 'document');
                    let vcfData = Buffer.from([]);
                    for await (const chunk of buffer) {
                        vcfData = Buffer.concat([vcfData, chunk]);
                    }

                    // Parse VCF content
                    const vcfContent = vcfData.toString('utf-8');
                    const contacts = vcard.parse(vcfContent);
                    const participants = contacts.map(contact => ({
                        id: contact.tel[0].value.replace(/[^0-9]/g, '') + '@s.whatsapp.net',
                        admin: null
                    }));

                    // Create group
                    const group = await sock.groupCreate(args, participants);
                    const groupId = group.id;
                    const inviteCode = await sock.groupInviteCode(groupId);

                    const responseMessage = `✅ *Group Created Successfully*\n\n` +
                        `*Name:* ${args}\n` +
                        `*ID:* ${groupId}\n` +
                        `*Link:* https://chat.whatsapp.com/${inviteCode}\n` +
                        `*Participants:* ${participants.length}`;

                    await sock.sendMessage(from, { text: responseMessage });
                } catch (error) {
                    await sock.sendMessage(from, { 
                        text: '❌ Error creating group: ' + error.message
                    });
                }
                break;
        }
    });
}

// Start the bot
connectToWhatsApp().catch(err => console.log('Unexpected error: ' + err));
