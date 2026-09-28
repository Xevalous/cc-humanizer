# Humanizer: Claude Code Plugin

Plugin Claude Code yang secara **otomatis mendeteksi, mengaudit, dan menegakkan aturan penulisan manusiawi (anti-AI writing patterns)** berdasarkan spesifikasi resmi [`blader/humanizer`](https://github.com/blader/humanizer) (Wikipedia: *Signs of AI writing*).

AI agent yang aktif di Claude Code akan otomatis diaudit tanpa perlu Anda memanggil command atau skill `/humanize` secara manual.

---

## Fitur Utama

1. **Injeksi Konteks Otomatis (`SessionStart`)**
   - Saat sesi Claude Code dimulai (`startup`, `resume`, `clear`), hook menginjeksikan ringkasan ringkas dan ketat dari aturan *humanizer* ke dalam context prompt agen.
   - Agen langsung mengetahui pantangan sebelum mulai menulis.

2. **Deteksi & Pemblokiran Sebelum Tulis (`PreToolUse`)**
   - Menginspeksi setiap operasi penulisan file (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) pada berkas prosa (`.md`, `.txt`, `.adoc`, `.rst`, `.html`).
   - Jika terdeteksi *hard violations* (seperti em dash, curly quotes, chatbot residue, staged run-ups, aphorisms, formula not-X-but-Y, atau klaim hiperbolik), operasi **otomatis di-deny (diblokir)** oleh hook, dan agen diarahkan untuk menulis ulang dengan gaya manusia.

3. **Audit Pasca Tulis (`PostToolUse`)**
   - Melakukan pemindaian sekunder terhadap file hasil akhir untuk memverifikasi kepadatan kata kunci AI (*density watchlist*) antar seksi.

4. **Audit Respons Percakapan Langsung (`Stop`)**
   - Saat agen selesai merespons sebelum mengakhiri turn, hook memeriksa transcript respons asisten. Jika ada formula obrolan chatbot seperti *"Certainly!"*, *"I hope this helps!"*, atau penggunaan em dash, hook memberikan feedback pengingat ke agen.

5. **Pengecualian Cerdas (*Safe Bypasses*)**
   - Mengabaikan blok kode (*fenced code* ` ``` `), kode sebaris (*inline code*), link/URL, dan frontmatter YAML agar tidak terjadi *false positive* pada kode program atau konfigurasi teknis.
   - Mendukung tag komentar lewati: `<!-- humanizer:skip -->`.

6. **Skill & Manual Command Tersedia**
   - Tetap menyediakan skill `humanizer:humanizer` sebagai referensi penuh.
   - Menyediakan perintah `/audit <filepath>` jika ingin melakukan audit manual pada berkas lama.

---

## Aturan yang Ditegakkan

Berdasarkan 25 aturan penulisan *blader/humanizer*:

- **Tanda Baca & Tipografi:** Tanpa em dash (`—`), en dash (`–`), atau double hyphen (`--`). Hanya tanda petik lurus (`"..."` dan `'`).
- **Residu Chatbot:** Larangan keras terhadap formula pembuka/penutup chatbot (*"Certainly!"*, *"Great question!"*, *"I hope this helps!"*, *"Let me know if you need anything else!"*).
- **Tanpa Staging:**
  - Larangan formula kontras *"not X but Y"* (*"It's not just about speed, it's about control"*).
  - Larangan penutup satu kalimat dramatis (*"That is the real win."*, *"Let that sink in."*).
  - Larangan peribahasa klise (*"at its core"*, *"what really matters"*, *"the heart of the matter"*).
  - Larangan *run-up* bertele-tele (*"Let's dive in"*, *"Here's what you need to know"*, *"Without further ado"*).
  - Larangan membantah bayangan (*"This isn't about..."*, *"Don't get me wrong..."*).
- **Tanpa Inflasi & Klise Korporat:**
  - Tanpa klaim warisan muluk (*"stands as a testament"*, *"plays a pivotal role"*, *"indelible mark"*).
  - Larangan *shallow -ing riders* (*"underscoring"*, *"highlighting"*, *"symbolizing"*).
  - Batasan kepadatan kosakata AI (*delve, tapestry, testament, intricate, robust, seamless, streamline, supercharge, leverage, vibrant, landscape, interplay*).
- **Format Bersih:**
  - Tanpa emoji dekoratif di judul atau poin daftar (`🚀`, `💡`).
  - Tanpa penebalan seragam di setiap butir list (`- **Label:** teks`).
  - Judul tidak boleh diulang di kalimat pertama tepat di bawahnya.

---

## Struktur Direktori Plugin

```text
cc-humanizer/
├── .claude-plugin/
│   └── plugin.json           # Manifest resmi plugin Claude Code
├── hooks/
│   ├── hooks.json            # Konfigurasi lifecycle hooks (SessionStart, PreToolUse, PostToolUse, Stop)
│   ├── session-start.cjs     # Hook injeksi aturan ke konteks sesi
│   ├── scan.cjs              # Hook audit pre-write (deny) dan post-write
│   └── stop-audit.cjs        # Hook audit respons asisten
├── lib/
│   └── rules.cjs             # Rules engine mandiri (tanpa dependensi eksternal)
├── skills/
│   └── humanizer/
│       └── SKILL.md          # Spesifikasi lengkap humanizer (v3.0.0)
├── commands/
│   └── audit.md              # Command manual /audit <file>
├── tests/
│   └── run-tests.cjs         # Unit test suite untuk engine & aturan
└── README.md
```

---

## Cara Menggunakan Plugin

### Opsi 1: Pasang via Marketplace (Direkomendasikan)
Tambahkan project ini sebagai marketplace di Claude Code:

```powershell
claude plugin marketplace add "C:\Users\Xevalous\Codes\Claude\cc-humanizer"
claude plugin install humanizer@cc-humanizer
```

Jika di-host di GitHub (`https://github.com/<owner>/cc-humanizer`):
```powershell
claude plugin marketplace add https://github.com/<owner>/cc-humanizer.git
claude plugin install humanizer@cc-humanizer
```

### Opsi 2: Muat Langsung untuk Sesi Saat Ini
Jalankan Claude Code dengan flag `--plugin-dir`:

```powershell
claude --plugin-dir "C:\Users\Xevalous\Codes\Claude\cc-humanizer"
```

---

## Menjalankan Pengujian

Plugin ini telah dilengkapi dengan unit test tanpa dependensi eksternal:

```powershell
node tests/run-tests.cjs
```

Semua 15 skenario pengujian aturan penulisan dan mekanisme hooks teruji berhasil.
