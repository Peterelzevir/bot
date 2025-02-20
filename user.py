import os
import sys
import time
import json
import asyncio
from datetime import datetime, timedelta
from telethon import TelegramClient, events
from telethon.tl.functions.channels import JoinChannelRequest, GetChannelsRequest
from telethon.tl.functions.messages import SendMessageRequest, GetDialogsRequest
from telethon.tl.types import InputPeerChannel, InputPeerChat, InputPeerUser
from telethon.errors import SessionPasswordNeededError
from colorama import init, Fore, Back, Style
from art import text2art

# Initialize colorama for colored terminal
init()

# Configuration
API_ID = 29410328
API_HASH = "d7ce7094b2439df3c18d6b3197f5322a"
CREATOR = "@hiyaok"
VERSION = "1.0.0"

# ASCII Art Banner
BANNER = """
██╗  ██╗██╗██╗   ██╗ █████╗  ██████╗ ██╗  ██╗
██║  ██║██║╚██╗ ██╔╝██╔══██╗██╔═══██╗██║ ██╔╝
███████║██║ ╚████╔╝ ███████║██║   ██║█████╔╝ 
██╔══██║██║  ╚██╔╝  ██╔══██║██║   ██║██╔═██╗ 
██║  ██║██║   ██║   ██║  ██║╚██████╔╝██║  ██╗
╚═╝  ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝
"""

# Storage
active_forwards = {}
banned_chats = set()
sessions_file = "sessions.json"
banned_file = "banned_chats.json"

def load_sessions():
    if os.path.exists(sessions_file):
        with open(sessions_file, 'r') as f:
            return json.load(f)
    return {}

def save_sessions(sessions):
    with open(sessions_file, 'w') as f:
        json.dump(sessions, f, indent=4)

def load_banned_chats():
    if os.path.exists(banned_file):
        with open(banned_file, 'r') as f:
            global banned_chats
            banned_chats = set(json.load(f))

def save_banned_chats():
    with open(banned_file, 'w') as f:
        json.dump(list(banned_chats), f)

def print_banner():
    print(Fore.CYAN + BANNER)
    print(Fore.MAGENTA + "╔══════════════════════════════════════╗")
    print(Fore.MAGENTA + f"║      Created by: {CREATOR}   ║")
    print(Fore.MAGENTA + f"║      Version: {VERSION}                    ║")
    print(Fore.MAGENTA + "╚══════════════════════════════════════╝\n")
    print(Style.RESET_ALL)

def extend_expiry():
    print_banner()
    sessions = load_sessions()
    
    if not sessions:
        print(Fore.RED + "❌ No userbots found!" + Style.RESET_ALL)
        return
        
    print(Fore.CYAN + "Available userbots:\n")
    for idx, (session, details) in enumerate(sessions.items(), 1):
        print(f"{idx}. Phone: {details['phone']}")
        print(f"   Created: {details['created_at']}")
        print(f"   Current Expiry: {details['expires_at']}\n")
        
    try:
        choice = int(input(Fore.GREEN + "Enter number to extend (0 to cancel): " + Style.RESET_ALL))
        if choice == 0:
            return
            
        if 1 <= choice <= len(sessions):
            session = list(sessions.keys())[choice-1]
            days = int(input(Fore.GREEN + "Enter additional days: " + Style.RESET_ALL))
            
            current_expiry = datetime.strptime(sessions[session]['expires_at'], '%Y-%m-%d %H:%M:%S')
            new_expiry = current_expiry + timedelta(days=days)
            
            sessions[session]['expires_at'] = new_expiry.strftime('%Y-%m-%d %H:%M:%S')
            sessions[session]['warning_sent'] = False  # Reset warning flag
            save_sessions(sessions)
            
            print(Fore.GREEN + "\n✅ Expiry extended successfully!")
            print(Fore.CYAN + f"New expiry: {new_expiry.strftime('%Y-%m-%d %H:%M:%S')}\n" + Style.RESET_ALL)
        else:
            print(Fore.RED + "\n❌ Invalid choice!" + Style.RESET_ALL)
            
    except ValueError:
        print(Fore.RED + "\n❌ Invalid input!" + Style.RESET_ALL)

async def check_expiry(client, session_name):
    """Check if userbot has expired and handle logout"""
    sessions = load_sessions()
    if session_name not in sessions:
        return True  # Session not found, consider expired
        
    expiry_date = datetime.strptime(sessions[session_name]['expires_at'], '%Y-%m-%d %H:%M:%S')
    now = datetime.now()
    
    # Send warning notification 1 day before expiry
    if now + timedelta(days=1) >= expiry_date and not sessions[session_name].get('warning_sent'):
        try:
            await client.send_message(
                'me',
                "⚠️ **EXPIRY WARNING**\n\n"
                "Your userbot will expire in 24 hours!\n"
                f"Session: {session_name}\n"
                f"Expiry: {expiry_date.strftime('%Y-%m-%d %H:%M:%S')}"
            )
            sessions[session_name]['warning_sent'] = True
            save_sessions(sessions)
        except Exception as e:
            print(f"Failed to send expiry warning: {e}")

    # Handle expiry
    if now >= expiry_date:
        try:
            # Send final notification
            await client.send_message(
                'me',
                "🚫 **USERBOT EXPIRED**\n\n"
                f"Session: {session_name}\n"
                "The userbot session will now be terminated."
            )
            
            # Logout and cleanup
            await client.log_out()
            if os.path.exists(f"{session_name}.session"):
                os.remove(f"{session_name}.session")
            
            # Remove from sessions file
            del sessions[session_name]
            save_sessions(sessions)
            
            return True
        except Exception as e:
            print(f"Error during expiry cleanup: {e}")
            return True
            
    return False

async def create_userbot():
    print_banner()
    
    # Create sessions directory if not exists
    if not os.path.exists("sessions"):
        os.makedirs("sessions")
    
    # Load banned chats
    load_banned_chats()
    
    phone = input(Fore.GREEN + "📱 Enter phone number: " + Style.RESET_ALL)
    days = int(input(Fore.GREEN + "⏳ Enter userbot expiry days: " + Style.RESET_ALL))
    
    session_name = f"sessions/iPhone_16_Pro_Max_{int(time.time())}"
    
    client = TelegramClient(
        session_name,
        API_ID,
        API_HASH,
        device_model="iPhone 16 Pro Max",
        system_version="iOS 17.4",
        app_version=VERSION
    )
    
    try:
        print(Fore.YELLOW + "\n⌛ Starting session..." + Style.RESET_ALL)
        await client.start()
        
        if not await client.is_user_authorized():
            await client.send_code_request(phone)
            code = input(Fore.GREEN + "📤 Enter the code you received: " + Style.RESET_ALL)
            
            try:
                await client.sign_in(phone, code)
            except SessionPasswordNeededError:
                password = input(Fore.GREEN + "🔐 Enter your 2FA password: " + Style.RESET_ALL)
                await client.sign_in(password=password)
        
        # Join required channels
        print(Fore.YELLOW + "\n⌛ Joining channels..." + Style.RESET_ALL)
        await client(JoinChannelRequest("listprojec"))
        await client(JoinChannelRequest("dagetfreenewnew"))
        
        # Send notification to creator
        print(Fore.YELLOW + "⌛ Sending creation notification..." + Style.RESET_ALL)
        await client.send_message(
            "hiyaok",
            f"🤖 Bot successfully created and will expire in {days} days\n\n"
            f"📱 Device: iPhone 16 Pro Max\n"
            f"📅 Created: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"⏳ Expires: {(datetime.now() + timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')}"
        )
        
        # Save session info
        sessions = load_sessions()
        sessions[session_name] = {
            "phone": phone,
            "created_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "expires_at": (datetime.now() + timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S'),
            "creator": CREATOR,
            "version": VERSION,
            "warning_sent": False
        }
        save_sessions(sessions)
        
        # Register event handlers
        @client.on(events.NewMessage(pattern=r'\.start'))
        async def start_handler(event):
            await handle_start(event)
            
        @client.on(events.NewMessage(pattern=r'\.cfd'))
        async def cfd_handler(event):
            await handle_cfd(event)
            
        @client.on(events.NewMessage(pattern=r'\.grup'))
        async def grup_handler(event):
            await handle_grup(event)
            
        @client.on(events.NewMessage(pattern=r'\.ban'))
        async def ban_handler(event):
            await handle_ban(event)
            
        @client.on(events.NewMessage(pattern=r'\.list'))
        async def list_handler(event):
            await handle_list(event)
            
        @client.on(events.NewMessage(pattern=r'\.forward (\d+)'))
        async def forward_handler(event):
            await handle_forward(event)
            
        @client.on(events.NewMessage(pattern=r'\.dellist'))
        async def dellist_handler(event):
            await handle_dellist(event)
            
        # Add periodic expiry check
        async def check_expiry_loop():
            while True:
                if await check_expiry(client, session_name):
                    print(Fore.RED + "\n🚫 Userbot session expired and terminated!" + Style.RESET_ALL)
                    return
                await asyncio.sleep(3600)  # Check every hour
        
        asyncio.create_task(check_expiry_loop())
        
        print(Fore.GREEN + "\n✅ Userbot created successfully!" + Style.RESET_ALL)
        print(Fore.CYAN + f"📅 Expires in: {days} days")
        print(Fore.CYAN + "📱 Device: iPhone 16 Pro Max")
        print(Fore.CYAN + f"🔄 Version: {VERSION}\n")
        
        await client.run_until_disconnected()
        
    except Exception as e:
        print(Fore.RED + f"\n❌ Error: {str(e)}" + Style.RESET_ALL)
        if os.path.exists(f"{session_name}.session"):
            os.remove(f"{session_name}.session")

async def handle_start(event):
    if event.sender_id != event.client.user_id:
        return
        
    help_text = """
🌟 **HIYAOK Userbot Commands** 🌟

`.start` - Show this help message
`.cfd` - Forward message to private/group chats
`.grup` - Show list of joined groups
`.ban` - Add chat/group to ban list
`.list` - Show active forwards
`.forward [delay]` - Start forwarding with delay
`.dellist` - Clear active forwards

💫 Created by HIYAOK Programmer
🔄 Version: {VERSION}
    """
    await event.respond(help_text)

async def handle_cfd(event):
    if event.sender_id != event.client.user_id:
        return
        
    if not event.is_reply:
        await event.respond("⚠️ Please reply to a message to forward")
        return
        
    try:
        replied = await event.get_reply_message()
        args = event.pattern_match.string.split()
        
        if len(args) < 2:
            await event.respond("⚠️ Please specify destination type (private/group)")
            return
            
        dest_type = args[1].lower()
        dialogs = await event.client.get_dialogs()
        
        if dest_type == "private":
            destinations = [d for d in dialogs if d.is_user and not d.entity.bot]
        elif dest_type == "group":
            destinations = [d for d in dialogs if d.is_group]
        else:
            await event.respond("⚠️ Invalid destination type (use private or group)")
            return
            
        for dest in destinations:
            if dest.id not in banned_chats:
                try:
                    await event.client.forward_messages(dest.id, replied)
                    await event.respond(f"✅ Forwarded to {dest.name}")
                except Exception as e:
                    await event.respond(f"❌ Failed to forward to {dest.name}: {str(e)}")
                await asyncio.sleep(2)  # Avoid flood wait
                
    except Exception as e:
        await event.respond(f"❌ Error: {str(e)}")

async def handle_ban(event):
    if event.sender_id != event.client.user_id:
        return
        
    try:
        chat_id = event.chat_id
        chat_name = event.chat.title if hasattr(event.chat, 'title') else event.chat.first_name
        
        if chat_id in banned_chats:
            banned_chats.remove(chat_id)
            save_banned_chats()
            await event.respond(f"✅ Removed {chat_name} from ban list")
        else:
            banned_chats.add(chat_id)
            save_banned_chats()
            await event.respond(f"🚫 Added {chat_name} to ban list")
            
    except Exception as e:
        await event.respond(f"❌ Error: {str(e)}")

async def handle_list(event):
    if event.sender_id != event.client.user_id:
        return
        
    if not active_forwards:
        await event.respond("📪 No active forwards")
        return
        
    response = "📋 **Active Forwards:**\n\n"
    for fwd_id, details in active_forwards.items():
        response += f"ID: `{fwd_id}`\n"
        response += f"Delay: {details['delay']} seconds\n"
        response += f"Status: {'🟢 Running' if details['running'] else '🔴 Stopped'}\n\n"
        
    await event.respond(response)

async def handle_forward(event):
    if event.sender_id != event.client.user_id:
        return
        
    if not event.is_reply:
        await event.respond("⚠️ Please reply to a message to forward")
        return
        
    try:
        delay = int(event.pattern_match.group(1))
        replied = await event.get_reply_message()
        groups = await event.client.get_dialogs()
        
        forward_id = str(time.time())
        active_forwards[forward_id] = {
            'message_id': replied.id,
            'chat_id': event.chat_id,
            'delay': delay,
            'running': True
        }
        
        await event.respond(f"✅ Forward started with ID: `{forward_id}`")
        
        total_groups = len([d for d in groups if d.is_group])
        success_count = 0
        fail_count = 0
        
        while active_forwards[forward_id]['running']:
            for dialog in groups:
                if dialog.is_group and dialog.entity.id not in banned_chats:
                    try:
                        # Check if source message still exists
                        try:
                            source_msg = await event.client.get_messages(
                                replied.chat_id,
                                ids=[replied.id]
                            )
                            if not source_msg:
                                raise Exception("Source message deleted")
                        except:
                            await event.respond(
                                "⚠️ Source message was deleted, stopping forward...\n"
                                f"✅ Successful: {success_count}\n"
                                f"❌ Failed: {fail_count}\n"
                                f"📊 Total Groups: {total_groups}"
                            )
                            del active_forwards[forward_id]
                            return
                            
                        # Forward message
                        await event.client.forward_messages(
                            dialog.entity.id,
                            replied
                        )
                        success_count += 1
                        await event.respond(f"✅ Forwarded to {dialog.name}")
                    except Exception as e:
                        fail_count += 1
                        await event.respond(f"❌ Failed to forward to {dialog.name}: {str(e)}")
                        
                    await asyncio.sleep(delay)
            
            # Show round summary
            await event.respond(
                "📊 **Forward Round Complete**\n\n"
                f"✅ Successful: {success_count}\n"
                f"❌ Failed: {fail_count}\n"
                f"📊 Total Groups: {total_groups}\n"
                f"⏳ Next round in {delay} seconds..."
            )
            
            await asyncio.sleep(delay)
            
    except Exception as e:
        await event.respond(f"❌ Error: {str(e)}")

async def handle_dellist(event):
    if event.sender_id != event.client.user_id:
        return
        
    active_forwards.clear()
    await event.respond("🗑️ All active forwards cleared")

def delete_userbot():
    print_banner()
    sessions = load_sessions()
    
    if not sessions:
        print(Fore.RED + "❌ No userbots found!" + Style.RESET_ALL)
        return
        
    print(Fore.CYAN + "Available userbots:\n")
    for idx, (session, details) in enumerate(sessions.items(), 1):
        print(f"{idx}. Phone: {details['phone']}")
        print(f"   Created: {details['created_at']}")
        print(f"   Expires: {details['expires_at']}\n")
        
    try:
        choice = int(input(Fore.GREEN + "Enter number to delete (0 to cancel): " + Style.RESET_ALL))
        if choice == 0:
            return
            
        if 1 <= choice <= len(sessions):
            session = list(sessions.keys())[choice-1]
            if os.path.exists(f"{session}.session"):
                os.remove(f"{session}.session")
            del sessions[session]
            save_sessions(sessions)
            print(Fore.GREEN + "\n✅ Userbot deleted successfully!" + Style.RESET_ALL)
        else:
            print(Fore.RED + "\n❌ Invalid choice!" + Style.RESET_ALL)
            
    except ValueError:
        print(Fore.RED + "\n❌ Invalid input!" + Style.RESET_ALL)

def list_userbots():
    print_banner()
    sessions = load_sessions()
    
    if not sessions:
        print(Fore.RED + "❌ No userbots found!" + Style.RESET_ALL)
        return
        
    print(Fore.CYAN + "Active userbots:\n")
    for session, details in sessions.items():
        print(f"📱 Phone: {details['phone']}")
        print(f"📅 Created: {details['created_at']}")
        print(f"⏳ Expires: {details['expires_at']}")
        print(f"👤 Creator: {details['creator']}")
        print(f"🔄 Version: {details['version']}\n")

def main():
    print_banner()
    
    while True:
        print(Fore.CYAN + "Select an option:")
        print("1. Create new userbot")
        print("2. Delete userbot")
        print("3. List userbots")
        print("4. Extend expiry")
        print("5. Exit\n" + Style.RESET_ALL)
        
        choice = input(Fore.GREEN + "Enter choice (1-5): " + Style.RESET_ALL)
        
        if choice == "1":
            asyncio.run(create_userbot())
        elif choice == "2":
            delete_userbot()
        elif choice == "3":
            list_userbots()
        elif choice == "4":
            extend_expiry()
        elif choice == "5":
            print(Fore.YELLOW + "\nGoodbye! 👋" + Style.RESET_ALL)
            sys.exit()
        else:
            print(Fore.RED + "\n❌ Invalid choice!" + Style.RESET_ALL)
        
        input(Fore.CYAN + "\nPress Enter to continue..." + Style.RESET_ALL)
        os.system('cls' if os.name == 'nt' else 'clear')
        print_banner()

if __name__ == "__main__":
    main()
