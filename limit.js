const { Telegraf, Markup } = require('telegraf');

// Bot token langsung di kode
const bot = new Telegraf('6463537586:AAGq0EdaBaYu-nqxt1INeQrUK0SBi8zDWAk');

// ID Admin dan Grup
const ADMIN_IDS = [5988451717]; // Ganti dengan ID admin
const GROUP_ID = -1001234567890; // Ganti dengan ID grup admin (opsional)

// Mode bot (grup/private)
let BOT_MODE = 'private'; // default mode private

// Command untuk mengatur mode bot (hanya admin)
bot.command('setmode', async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Perintah ini hanya untuk admin!');
    }
    
    const mode = ctx.message.text.split(' ')[1];
    if (!mode || !['private', 'group'].includes(mode.toLowerCase())) {
        return ctx.reply(
            '⚙️ *Pengaturan Mode Bot*\n\n' +
            'Gunakan format:\n' +
            '`/setmode private` - Mode private chat\n' +
            '`/setmode group` - Mode grup\n\n' +
            `Mode saat ini: *${BOT_MODE}*`, 
            { parse_mode: 'Markdown' }
        );
    }
    
    BOT_MODE = mode.toLowerCase();
    ctx.reply(`✅ Mode bot berhasil diubah ke: *${BOT_MODE}*`, { parse_mode: 'Markdown' });
});

// Handle command /getid - works for all users
bot.command('getid', async (ctx) => {
    const message = ctx.message;
    const chat = message.chat;
    
    if (chat.type === 'private') {
        await ctx.replyWithMarkdown(
            `*📱 Info User*\n\n` +
            `*User ID:* \`${message.from.id}\`\n` +
            `*Nama:* ${message.from.first_name} ${message.from.last_name || ''}\n` +
            `*Username:* ${message.from.username ? '@' + message.from.username : 'Tidak ada'}`
        );
    } else {
        await ctx.replyWithMarkdown(
            `*ℹ️ Info Chat*\n\n` +
            `*Chat ID:* \`${chat.id}\`\n` +
            `*Tipe:* ${chat.type}\n` +
            `*Nama Grup:* ${chat.title}\n\n` +
            `*👤 Info Pengirim*\n` +
            `*User ID:* \`${message.from.id}\`\n` +
            `*Nama:* ${message.from.first_name} ${message.from.last_name || ''}\n` +
            `*Username:* ${message.from.username ? '@' + message.from.username : 'Tidak ada'}`
        );
    }
});

// Handle command /ping - check bot status
bot.command('ping', async (ctx) => {
    const start = Date.now();
    const message = await ctx.reply('🏓 Pong!');
    const responseTime = Date.now() - start;
    
    await ctx.telegram.editMessageText(
        message.chat.id, 
        message.message_id, 
        null,
        `🏓 Pong!\n\n⚡ Response Time: ${responseTime}ms\n🤖 Bot Status: Active`
    );
});

// Handle command /info - get bot info
bot.command('info', async (ctx) => {
    const botInfo = await ctx.telegram.getMe();
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    const infoMessage = `*🤖 Bot Information*\n\n` +
        `*Nama Bot:* ${botInfo.first_name}\n` +
        `*Username:* @${botInfo.username}\n` +
        `*Bot ID:* \`${botInfo.id}\`\n\n` +
        `*⚡ Status*\n` +
        `*Uptime:* ${hours}h ${minutes}m ${seconds}s\n` +
        `*Mode:* ${BOT_MODE}\n\n` +
        `_Powered by @hiyaok_`;
    
    await ctx.replyWithMarkdown(infoMessage);
});

// Handle command /help - show available commands
bot.command('help', async (ctx) => {
    const helpMessage = `*📚 Daftar Perintah*\n\n` +
        `/start - Mulai bot\n` +
        `/getid - Dapatkan ID chat/user\n` +
        `/ping - Cek status bot\n` +
        `/info - Informasi bot\n` +
        `/help - Tampilkan bantuan ini\n\n` +
        `*🔒 Perintah Admin*\n` +
        `/setmode - Atur mode bot\n` +
        `/stats - Statistik bot\n\n` +
        `_Support all media types_\n` +
        `_Reply message supported_\n\n` +
        `Support by @hiyaok`;
    
    await ctx.replyWithMarkdown(helpMessage);
});

// Handle command /start
bot.command('start', async (ctx) => {
    const welcomeMessage = `*🌟 Selamat Datang di Support Bot!*

_Bot ini akan membantu menghubungkan Anda dengan @hiyaok_

*Fitur Utama:*
\`• Support semua jenis media
• Komunikasi langsung dengan admin
• Respon cepat & handal
• Mode Grup & Private Chat\`

> Silakan kirim pesan Anda, @hiyaok akan segera merespon!

💫 Support by @hiyaok`;

    await ctx.replyWithMarkdown(welcomeMessage);
});

// Handle command /stats (admin only)
bot.command('stats', async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) {
        return ctx.reply('⛔ Perintah ini hanya untuk admin!');
    }

    const stats = `📊 *Statistik Bot*

*Mode:* ${BOT_MODE}
*Admin:* ${ADMIN_IDS.length} orang
*Status:* Active ✅

_Powered by @hiyaok_`;

    await ctx.replyWithMarkdown(stats);
});

// Handle pesan dari user
bot.on(['message', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'sticker'], async (ctx) => {
    // Abaikan pesan dari bot
    if (ctx.message.from.is_bot) return;

    const userId = ctx.message.from.id;
    const isAdmin = ADMIN_IDS.includes(userId);

    // Handle admin reply
    if (isAdmin && ctx.message.reply_to_message) {
        try {
            const originalMessage = ctx.message.reply_to_message;
            // Cek apakah ada forwarded_from info
            if (!originalMessage.forward_from && !originalMessage.forward_sender_name) {
                return ctx.reply('❌ Tidak dapat menemukan pengirim asli pesan ini');
            }

            const targetId = originalMessage.forward_from ? originalMessage.forward_from.id : null;
            if (!targetId) {
                return ctx.reply('⚠️ User memiliki privacy forward message, tidak dapat mengirim balasan');
            }

            // Forward balasan admin ke user
            await forwardAdminReply(ctx, targetId);
            await ctx.reply('✅ Pesan terkirim ke user!', { reply_to_message_id: ctx.message.message_id });
            return;
        } catch (error) {
            console.error('Error handling admin reply:', error);
            await ctx.reply('❌ Gagal mengirim pesan ke user');
            return;
        }
    }

    // Handle pesan dari user biasa
    if (!isAdmin) {
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const userInfo = `👤 *Info Pengirim*
        
*Nama:* ${ctx.message.from.first_name} ${ctx.message.from.last_name || ''}
*Username:* ${ctx.message.from.username ? '@' + ctx.message.from.username : 'Tidak ada'}
*User ID:* \`${ctx.message.from.id}\`
*Waktu:* ${timestamp}`;

        try {
            // Kirim info user
            const destination = BOT_MODE === 'group' ? GROUP_ID : ADMIN_IDS[0];
            await bot.telegram.sendMessage(destination, userInfo, { parse_mode: 'Markdown' });
            
            // Forward pesan user
            await forwardToAdmin(ctx, destination);
            
            // Kirim konfirmasi ke user
            const replyMsg = `✅ *Pesan Anda telah diteruskan ke admin!*
            
_Mohon tunggu balasan dari admin kami._

⏰ Waktu terkirim: ${timestamp}`;
            
            await ctx.replyWithMarkdown(replyMsg, { reply_to_message_id: ctx.message.message_id });
        } catch (error) {
            console.error('Error forwarding message:', error);
            await ctx.reply('❌ Maaf, terjadi kesalahan. Silakan coba lagi nanti.');
        }
    }
});

// Function untuk forward pesan ke admin
async function forwardToAdmin(ctx, destination) {
    try {
        await ctx.forwardMessage(destination);
    } catch (error) {
        console.error('Error forwarding to admin:', error);
        throw error;
    }
}

// Function untuk forward balasan admin ke user
async function forwardAdminReply(ctx, userId) {
    try {
        const message = ctx.message;
        
        // Handle berbagai jenis media
        if (message.text) {
            await bot.telegram.sendMessage(userId, message.text, {
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.photo) {
            await bot.telegram.sendPhoto(userId, message.photo[0].file_id, {
                caption: message.caption,
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.video) {
            await bot.telegram.sendVideo(userId, message.video.file_id, {
                caption: message.caption,
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.document) {
            await bot.telegram.sendDocument(userId, message.document.file_id, {
                caption: message.caption,
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.voice) {
            await bot.telegram.sendVoice(userId, message.voice.file_id, {
                caption: message.caption,
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.video_note) {
            await bot.telegram.sendVideoNote(userId, message.video_note.file_id, {
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        } else if (message.sticker) {
            await bot.telegram.sendSticker(userId, message.sticker.file_id, {
                reply_to_message_id: message.reply_to_message.forward_from_message_id
            });
        }
    } catch (error) {
        console.error('Error sending admin reply:', error);
        throw error;
    }
}

// Error handler
bot.catch((err, ctx) => {
    console.error(`Error: ${ctx.updateType}`, err);
});

// Start bot
bot.launch().then(() => {
    console.log('🚀 Bot telah aktif dan siap digunakan!');
}).catch((err) => {
    console.error('❌ Gagal menjalankan bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
