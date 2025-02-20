# HIYAOK Telegram Userbot

Userbot Telegram yang powerful dengan fitur forwarding otomatis, manajemen grup, dan tampilan terminal yang estetik.

## ✨ Fitur Unggulan

### 🤖 Fitur Utama
- Forward pesan otomatis dengan delay yang bisa diatur
- Manajemen grup dan chat pribadi
- Sistem banned untuk chat yang tidak diinginkan
- Tampilan terminal keren dengan ASCII art
- Manajemen sesi dengan sistem expired

### 🛡️ Fitur Keamanan
- Command hanya bisa dipakai owner
- Dukungan 2FA saat login
- Pengaturan masa expired
- Logout otomatis saat expired

### 📱 Emulasi Perangkat
- Model iPhone 16 Pro Max
- Sistem iOS 17.4
- User agent profesional

## 🚀 Persyaratan Sistem

```bash
Python 3.8 atau lebih tinggi
pip install -r requirements.txt
```

Package Python yang dibutuhkan:
- telethon
- colorama
- art

## 💻 Cara Install

1. Clone repository:
   ```bash
   git clone https://github.com/yourusername/hiyaok-userbot.git
   cd hiyaok-userbot
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Jalankan userbot:
   ```bash
   python userbot.py
   ```

## 📚 Menu Terminal

Terminal menyediakan beberapa opsi:

1. **Buat userbot baru**
   - Setup sesi Telegram baru
   - Atur masa expired
   - Auto-join channel yang diperlukan

2. **Hapus userbot**
   - Lihat daftar sesi yang ada
   - Hapus sesi yang dipilih
   - Bersihkan file sesi

3. **List userbot**
   - Lihat semua sesi aktif
   - Cek tanggal expired
   - Monitor status sesi

4. **Perpanjang expired**
   - Pilih sesi userbot
   - Tambah jumlah hari
   - Update tanggal expired

5. **Keluar**
   - Tutup aplikasi dengan aman

## 🔧 Command Userbot

### Command Dasar
| Command | Fungsi |
|---------|---------|
| `.start` | Tampilkan pesan bantuan dan daftar command |
| `.grup` | Lihat daftar grup yang diikuti beserta status |
| `.list` | Tampilkan tugas forward yang aktif |

### Sistem Forward
| Command | Fungsi |
|---------|---------|
| `.cfd [private/group]` | Forward pesan ke tipe chat tertentu |
| `.forward [delay]` | Mulai forward terus-menerus dengan delay |
| `.dellist` | Hapus semua forward aktif |

### Manajemen Chat
| Command | Fungsi |
|---------|---------|
| `.ban` | Toggle status ban untuk chat/grup saat ini |

## 🔄 Detail Sistem Forward

### Forward Sekali (`.cfd`)
- Reply pesan + tentukan tipe tujuan
- Forward ke semua chat dengan tipe yang ditentukan
- Otomatis skip chat yang dibanned
- Tampilkan status sukses/gagal untuk setiap forward

### Forward Berkelanjutan (`.forward`)
```
.forward 60  # Forward dengan delay 60 detik
```
- Forward pesan terus-menerus ke semua grup
- Delay antar putaran bisa diatur
- Tracking progress dan statistik
- Auto-stop jika pesan sumber dihapus
- Otomatis skip grup yang dibanned

## 🚫 Sistem Ban

- Toggle status ban dengan command `.ban`
- Daftar chat yang dibanned disimpan permanen
- Otomatis skip chat yang dibanned saat forward
- Lihat status banned di daftar `.grup`

## ⚙️ Manajemen Sesi

### Pembuatan
1. Masukkan nomor telepon
2. Tentukan masa expired
3. Selesaikan 2FA jika aktif
4. Auto-join channel yang diperlukan
5. Kirim notifikasi pembuatan

### Sistem Expired
- Notifikasi peringatan 24 jam sebelum expired
- Logout otomatis saat expired
- Pembersihan file sesi
- Masa expired bisa diperpanjang

## 🔔 Notifikasi

Userbot mengirim berbagai notifikasi:
- Sukses/gagal forward
- Perubahan status ban
- Peringatan expired
- Pemutusan sesi
- Statistik penyelesaian putaran

## 🎨 Fitur Estetik

- Output terminal berwarna
- Banner ASCII art
- Respon dengan emoji
- Format profesional
- Indikator status yang jelas

## ⚠️ Catatan Penting

1. **Rate Limit**: 
   - Gunakan delay yang masuk akal untuk menghindari limit Telegram
   - Delay minimum yang disarankan: 30 detik

2. **Keamanan Sesi**:
   - Jangan share file sesi
   - Backup sessions.json
   - Pantau tanggal expired

3. **Auto-Join**:
   - t.me/listprojec
   - t.me/dagetfreenewnew

4. **Panduan Penggunaan**:
   - Hanya gunakan di akun sendiri
   - Ikuti Terms of Service Telegram
   - Jaga volume forward tetap wajar

## 📝 Logging

- Statistik forward tersimpan
- Daftar ban tersimpan permanen
- Tracking sesi
- Log error

## 🤝 Dukungan

Untuk dukungan dan update:
- Join @listprojec
- Hubungi @hiyaok
- Cek update versi

## 🔄 Riwayat Versi

- v1.0.0: Rilis awal
  - Sistem forward utama
  - Manajemen ban
  - Sistem expired
  - Tampilan terminal

## 📄 Lisensi

Proyek ini dilisensikan di bawah Lisensi MIT - lihat file [LICENSE](LICENSE) untuk detail.

---
Dibuat dengan 💖 oleh HIYAOK Programmer
