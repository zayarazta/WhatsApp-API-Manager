// developer by zaya razta
// 08-03-2026

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const session = require("express-session");

// --- KONFIGURASI MYSQL ---
// Sesuaikan host, user, dan password dengan pengaturan MySQL Anda
const dbConfig = {
  host: "localhost",
  user: "root",
  password: "",
  database: "whatsapp_db",
};

let pool;

/**
 * Inisialisasi Database
 * Membuat tabel-tabel yang diperlukan jika belum ada
 */
async function initDb() {
  try {
    pool = mysql.createPool(dbConfig);
    console.log("Terhubung ke Database MySQL");

    // Tabel Users untuk Login
    await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Tabel Kontak
    await pool.query(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                number VARCHAR(20) NOT NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Tabel Riwayat Pesan
    await pool.query(`
            CREATE TABLE IF NOT EXISTS message_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                receiver_number VARCHAR(20) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('sent', 'failed') DEFAULT 'sent',
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Tambah user admin default jika tabel kosong
    const [rows] = await pool.query("SELECT * FROM users LIMIT 1");
    if (rows.length === 0) {
      await pool.query("INSERT INTO users (username, password) VALUES (?, ?)", ["admin", "admin123"]);
      console.log("User admin default telah dibuat: admin / admin123");
    }
  } catch (err) {
    console.error("Koneksi MySQL Gagal:", err);
  }
}

// Inisialisasi Express, Server HTTP, dan Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

// Konfigurasi Session
app.use(
  session({
    secret: "secret-key-whatsapp-api",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  }),
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/**
 * Middleware Autentikasi
 * Melindungi rute agar tidak bisa diakses tanpa login
 */
const isAuthenticated = (req, res, next) => {
  if (req.session.isLoggedIn) return next();
  if (req.path.startsWith("/api/") || req.path === "/send-message") {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

// Inisialisasi WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    handleSIGINT: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

// --- ROUTES UI ---
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp API Dashboard</title>
        <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 min-h-screen p-4">
        
        <!-- Login Form -->
        <div id="login-section" class="${req.session.isLoggedIn ? "hidden" : ""} max-w-md mx-auto bg-white p-8 rounded-xl shadow-md mt-20 text-center">
            <h1 class="text-2xl font-bold mb-6 text-gray-800">Login Dashboard</h1>
            <div class="space-y-4 text-left">
                <div>
                    <label class="block text-sm text-gray-600 mb-1">Username</label>
                    <input type="text" id="username" class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 outline-none">
                </div>
                <div>
                    <label class="block text-sm text-gray-600 mb-1">Password</label>
                    <input type="password" id="password" class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 outline-none">
                </div>
                <button onclick="handleLogin()" class="w-full bg-green-600 text-white font-bold py-2 rounded-lg hover:bg-green-700 transition">Masuk</button>
            </div>
            <p id="login-error" class="text-red-500 text-xs mt-4 hidden">Username atau password salah!</p>
        </div>

        <!-- Dashboard Utama -->
        <div id="dashboard-section" class="${req.session.isLoggedIn ? "" : "hidden"} max-w-6xl mx-auto space-y-6">
            <div class="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border">
                <h1 class="text-xl font-bold text-green-600 flex items-center gap-2">
                    <span>📱</span> WhatsApp API Manager
                </h1>
                <div class="flex items-center gap-4">
                    <span id="global-status" class="text-xs font-semibold px-2 py-1 rounded bg-gray-200 text-gray-600">MENUNGGU...</span>
                    <button onclick="handleLogout()" class="text-red-500 hover:bg-red-50 px-3 py-1 rounded-lg transition text-sm">Keluar</button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <!-- Sidebar: Status & Kirim Cepat -->
                <div class="bg-white p-6 rounded-xl shadow-sm border space-y-6">
                    <div>
                        <h2 class="font-bold text-gray-700 mb-4 text-sm uppercase">Koneksi</h2>
                        <div id="qrcode-container" class="flex flex-col items-center p-4 border-2 border-dashed rounded-lg bg-gray-50">
                            <div id="qrcode"></div>
                            <p id="qr-text" class="text-[10px] text-gray-400 mt-2 text-center">Scan QR untuk menghubungkan</p>
                        </div>
                        <div id="info" class="hidden text-center py-4 bg-green-50 text-green-600 rounded-lg border border-green-200">
                            <span class="font-bold">TERKONEKSI</span>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <div>
                        <h2 class="font-bold text-gray-700 mb-4 text-sm uppercase">Kirim Pesan Cepat</h2>
                        <div class="space-y-3">
                            <input type="text" id="msg-number" placeholder="628123..." class="w-full text-sm border p-2 rounded-lg outline-none focus:border-blue-500">
                            <textarea id="msg-content" placeholder="Ketik pesan di sini..." class="w-full text-sm border p-2 rounded-lg outline-none focus:border-blue-500 h-24"></textarea>
                            <button onclick="sendQuickMessage()" id="btn-send" class="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold hover:bg-blue-700">Kirim Pesan</button>
                        </div>
                    </div>
                </div>

                <!-- Main Content: Kontak & Riwayat -->
                <div class="lg:col-span-3 space-y-6">
                    <!-- Tabel Kontak -->
                    <div class="bg-white p-6 rounded-xl shadow-sm border">
                        <div class="flex justify-between items-center mb-4">
                            <h2 class="font-bold text-gray-700">Daftar Kontak</h2>
                            <button onclick="openModal()" class="bg-green-600 text-white px-3 py-1 rounded-lg text-xs">+ Tambah</button>
                        </div>
                        <div class="overflow-x-auto max-h-64">
                            <table class="w-full text-left text-xs">
                                <thead class="bg-gray-50 text-gray-500 sticky top-0">
                                    <tr>
                                        <th class="p-3">Nama</th>
                                        <th class="p-3">Nomor WA</th>
                                        <th class="p-3 text-right">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody id="contact-list" class="divide-y"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Tabel Riwayat Pesan -->
                    <div class="bg-white p-6 rounded-xl shadow-sm border">
                        <h2 class="font-bold text-gray-700 mb-4">Riwayat Pesan Terkirim</h2>
                        <div class="overflow-x-auto max-h-80">
                            <table class="w-full text-left text-[11px]">
                                <thead class="bg-gray-50 text-gray-500 sticky top-0">
                                    <tr>
                                        <th class="p-3">Tujuan</th>
                                        <th class="p-3">Pesan</th>
                                        <th class="p-3">Waktu</th>
                                        <th class="p-3 text-center">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="message-list" class="divide-y"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Modal CRUD Kontak -->
        <div id="modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div class="bg-white rounded-xl w-full max-w-xs p-6 shadow-2xl">
                <h3 class="font-bold text-lg mb-4" id="modal-title">Tambah Kontak</h3>
                <input type="hidden" id="edit-id">
                <div class="space-y-3">
                    <input type="text" id="contact-name" placeholder="Nama Lengkap" class="w-full border p-2 rounded-lg outline-none">
                    <input type="text" id="contact-number" placeholder="628..." class="w-full border p-2 rounded-lg outline-none">
                </div>
                <div class="flex justify-end gap-2 mt-6">
                    <button onclick="closeModal()" class="text-gray-400 text-sm px-3">Batal</button>
                    <button onclick="saveContact()" class="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-bold">Simpan</button>
                </div>
            </div>
        </div>

        <script>
            const socket = io();

            // Handle Login
            async function handleLogin() {
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if(data.success) location.reload();
                else document.getElementById('login-error').classList.remove('hidden');
            }

            // Handle Logout
            async function handleLogout() {
                await fetch('/api/logout', { method: 'POST' });
                location.reload();
            }

            // Socket Listeners untuk Status WA
            socket.on('qr', (qr) => {
                const qrDiv = document.getElementById('qrcode');
                if (qrDiv) {
                    qrDiv.innerHTML = "";
                    new QRCode(qrDiv, { text: qr, width: 150, height: 150 });
                    document.getElementById('global-status').innerText = "MENUNGGU SCAN";
                    document.getElementById('global-status').className = "text-xs font-semibold px-2 py-1 rounded bg-yellow-100 text-yellow-600";
                }
            });

            socket.on('ready', () => {
                document.getElementById('qrcode-container').classList.add('hidden');
                document.getElementById('info').classList.remove('hidden');
                document.getElementById('global-status').innerText = "TERKONEKSI";
                document.getElementById('global-status').className = "text-xs font-semibold px-2 py-1 rounded bg-green-100 text-green-600";
            });

            socket.on('disconnected', () => {
                document.getElementById('qrcode-container').classList.remove('hidden');
                document.getElementById('info').classList.add('hidden');
                document.getElementById('global-status').innerText = "TERPUTUS";
                document.getElementById('global-status').className = "text-xs font-semibold px-2 py-1 rounded bg-red-100 text-red-600";
            });

            // Load Data Tables
            async function loadData() {
                try {
                    // Load Contacts
                    const resC = await fetch('/api/contacts');
                    const contacts = await resC.json();
                    document.getElementById('contact-list').innerHTML = contacts.map(c => \`
                        <tr class="hover:bg-gray-50">
                            <td class="p-3 font-medium">\${c.name}</td>
                            <td class="p-3 text-gray-500">\${c.number}</td>
                            <td class="p-3 text-right">
                                <button onclick="useContact('\${c.number}')" class="text-blue-500 hover:underline mr-3 font-semibold">Pilih</button>
                                <button onclick="deleteContact(\${c.id})" class="text-red-400 hover:text-red-600">Hapus</button>
                            </td>
                        </tr>
                    \`).join('');

                    // Load Messages
                    const resM = await fetch('/api/messages');
                    const messages = await resM.json();
                    document.getElementById('message-list').innerHTML = messages.map(m => \`
                        <tr class="hover:bg-gray-50">
                            <td class="p-3 text-gray-600 font-bold">\${m.receiver_number}</td>
                            <td class="p-3 text-gray-500 italic">\${m.message}</td>
                            <td class="p-3 text-gray-400">\${new Date(m.sent_at).toLocaleString('id-ID')}</td>
                            <td class="p-3 text-center">\${m.status === 'sent' ? '<span class="text-green-500">✅</span>' : '<span class="text-red-500">❌</span>'}</td>
                        </tr>
                    \`).join('');
                } catch(e) {}
            }

            function useContact(num) {
                document.getElementById('msg-number').value = num;
                document.getElementById('msg-content').focus();
            }

            // Kirim Pesan
            async function sendQuickMessage() {
                const number = document.getElementById('msg-number').value;
                const message = document.getElementById('msg-content').value;
                const btn = document.getElementById('btn-send');

                if(!number || !message) return alert('Nomor dan pesan wajib diisi!');

                btn.disabled = true;
                btn.innerText = "Mengirim...";

                try {
                    const res = await fetch('/send-message', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ number, message })
                    });
                    if(res.ok) {
                        document.getElementById('msg-content').value = "";
                        loadData();
                    } else {
                        alert('Gagal mengirim pesan. Pastikan WA terhubung.');
                    }
                } catch(e) {
                    alert('Error: ' + e.message);
                } finally {
                    btn.disabled = false;
                    btn.innerText = "Kirim Pesan";
                }
            }

            // CRUD Kontak Logic
            window.openModal = () => document.getElementById('modal').classList.remove('hidden');
            window.closeModal = () => document.getElementById('modal').classList.add('hidden');

            window.saveContact = async () => {
                const name = document.getElementById('contact-name').value;
                const number = document.getElementById('contact-number').value;
                if(!name || !number) return alert('Data tidak lengkap!');
                
                await fetch('/api/contacts', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({name, number})
                });
                closeModal();
                loadData();
            };

            window.deleteContact = async (id) => {
                if(confirm('Hapus kontak ini?')) {
                    await fetch(\`/api/contacts/\${id}\`, {method:'DELETE'});
                    loadData();
                }
            };

            // Inisialisasi awal jika sudah login
            if (${req.session.isLoggedIn ? "true" : "false"}) {
                loadData();
            }
        </script>
    </body>
    </html>
    `);
});

// --- API ENDPOINTS ---

// Login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
    if (rows.length > 0) {
      req.session.isLoggedIn = true;
      req.session.username = username;
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Kontak API
app.get("/api/contacts", isAuthenticated, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM contacts ORDER BY name ASC");
  res.json(rows);
});

app.post("/api/contacts", isAuthenticated, async (req, res) => {
  const { name, number } = req.body;
  await pool.query("INSERT INTO contacts (name, number) VALUES (?, ?)", [name, number]);
  res.json({ success: true });
});

app.delete("/api/contacts/:id", isAuthenticated, async (req, res) => {
  await pool.query("DELETE FROM contacts WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});

// Pesan Riwayat API
app.get("/api/messages", isAuthenticated, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM message_history ORDER BY sent_at DESC LIMIT 50");
  res.json(rows);
});

// Send Message Engine
app.post("/send-message", isAuthenticated, async (req, res) => {
  const { number, message } = req.body;
  const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
  let status = "sent";

  try {
    await client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (error) {
    status = "failed";
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // Catat riwayat ke MySQL
    await pool.query("INSERT INTO message_history (receiver_number, message, status) VALUES (?, ?, ?)", [number, message, status]);
  }
});

// --- WHATSAPP EVENTS ---
client.on("qr", (qr) => io.emit("qr", qr));
client.on("ready", () => {
  console.log("WhatsApp Client is ready!");
  io.emit("ready");
});
client.on("disconnected", (reason) => {
  console.log("WhatsApp Disconnected:", reason);
  io.emit("disconnected");
  client.initialize(); // Auto re-init
});

// --- BOOTSTRAP APP ---
async function startApp() {
  await initDb();
  client.initialize();
  server.listen(port, () => {
    console.log(`=========================================`);
    console.log(`Developer : zaya razta`);
    console.log(`Dashboard : http://localhost:${port}`);
    console.log(`Username  : admin`);
    console.log(`Password  : admin123`);
    console.log(`=========================================`);
  });
}

startApp();
