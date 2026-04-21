const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const runtimeBasePath = process.cwd();
const defaultCacheRoot = path.join(runtimeBasePath, '.cache');
const defaultPuppeteerCache = path.join(defaultCacheRoot, 'puppeteer');

if (!process.env.XDG_CACHE_HOME || process.env.XDG_CACHE_HOME === '/opt/render/.cache') {
    process.env.XDG_CACHE_HOME = defaultCacheRoot;
}
if (!process.env.PUPPETEER_CACHE_DIR || process.env.PUPPETEER_CACHE_DIR === '/opt/render/.cache/puppeteer') {
    process.env.PUPPETEER_CACHE_DIR = defaultPuppeteerCache;
}

fs.mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
fs.mkdirSync(process.env.PUPPETEER_CACHE_DIR, { recursive: true });

let puppeteer = null;

try {
    puppeteer = require('puppeteer');
} catch (e) {
    puppeteer = null;
}

const isPackaged = typeof process.pkg !== 'undefined';
let basePath = (typeof __dirname !== 'undefined' && __dirname) ? __dirname : process.cwd();
if (isPackaged) basePath = process.cwd();

let chromeInstallAttempted = false;
let chromeExecutablePath = undefined;
let chromePreparationError = null;

function findChromeExecutable(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return undefined;
    const executableNames = process.platform === 'win32' ? ['chrome.exe'] : ['chrome'];
    const queue = [rootDir];

    while (queue.length) {
        const currentDir = queue.shift();
        let entries = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (e) {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (!executableNames.includes(entry.name)) continue;
            if (process.platform !== 'win32' && !fullPath.includes('chrome-linux')) continue;
            return fullPath;
        }
    }

    return undefined;
}

function resolveWritableDataDir() {
    const candidates = [
        process.env.DATA_DIR,
        process.env.RENDER_DISK_PATH ? path.join(process.env.RENDER_DISK_PATH, 'bot-whatsapp') : null,
        fs.existsSync('/var/data') ? '/var/data/bot-whatsapp' : null,
        path.join(basePath, 'data')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.W_OK);
            return candidate;
        } catch (e) {
            // tenta o proximo caminho disponivel
        }
    }

    return path.join(basePath, 'data');
}

function resolveChromeExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
        console.warn(`[Boot] Ignorando PUPPETEER_EXECUTABLE_PATH invalido: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }
    const cachedChrome = findChromeExecutable(process.env.PUPPETEER_CACHE_DIR);
    if (cachedChrome) return cachedChrome;
    if (!puppeteer || typeof puppeteer.executablePath !== 'function') return undefined;
    try {
        const executable = puppeteer.executablePath();
        if (executable && fs.existsSync(executable)) return executable;
        console.warn('[Boot] Puppeteer nao retornou um executavel Chrome valido');
        return undefined;
    } catch (e) {
        console.warn('[Boot] Falha ao resolver executavel do Chrome pelo Puppeteer:', e.message);
        return undefined;
    }
}

function ensureChromeInstalled() {
    const existingExecutable = resolveChromeExecutable();
    if (existingExecutable) return existingExecutable;
    if (!puppeteer || chromeInstallAttempted) return undefined;

    chromeInstallAttempted = true;
    try {
        const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        console.log(`[Boot] Chrome nao encontrado. Instalando via Puppeteer em ${process.env.PUPPETEER_CACHE_DIR}...`);
        const output = execFileSync(npxCommand, ['puppeteer', 'browsers', 'install', 'chrome', '--path', process.env.PUPPETEER_CACHE_DIR], {
            cwd: basePath,
            env: process.env,
            stdio: 'pipe'
        });
        if (output) console.log(output.toString());
        const executableAfterInstall = resolveChromeExecutable();
        if (executableAfterInstall) {
            console.log(`[Boot] Chrome instalado em ${executableAfterInstall}`);
            return executableAfterInstall;
        }
    } catch (e) {
        const details = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join('\n');
        console.error('[Boot] Falha ao instalar Chrome automaticamente:', details);
    }

    return undefined;
}

function prepareChromeForRuntime() {
    chromePreparationError = null;
    chromeExecutablePath = ensureChromeInstalled();

    if (chromeExecutablePath) {
        process.env.PUPPETEER_EXECUTABLE_PATH = chromeExecutablePath;
        console.log(`[Boot] chromeExecutable=${chromeExecutablePath}`);
        return chromeExecutablePath;
    }

    chromePreparationError = 'Chrome nao disponivel para iniciar o WhatsApp. Verifique os logs de boot do Render.';
    console.error(`[Boot] ${chromePreparationError}`);
    return undefined;
}

const dataDir = resolveWritableDataDir();
const dbPath = process.env.DB_PATH || path.join(dataDir, 'db.sqlite');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
console.log(`[Boot] dataDir=${dataDir}`);
console.log(`[Boot] dbPath=${dbPath}`);

const db = new sqlite3.Database(dbPath);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'user', is_paused INTEGER DEFAULT 0, created_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS configs (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE, menu_message TEXT, default_reply TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, user_id INTEGER, key_num TEXT, title TEXT, response TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS keywords (id INTEGER PRIMARY KEY, user_id INTEGER, keyword TEXT, response TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS blacklist (id INTEGER PRIMARY KEY, user_id INTEGER, phone_number TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, user_id INTEGER, sender TEXT, msg TEXT, opt TEXT, ts TEXT, created_date TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.get("SELECT * FROM users WHERE role='admin'", (err, row) => {
        if (!row) db.run("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, datetime('now'))", ['admin', bcrypt.hashSync('admin', 10), 'admin']);
    });
});

const clients = {}, qrCodes = {}, connectedUsers = new Set(), clientErrors = {};

function getUserAuthPath(userId) { return path.join(dataDir, `.wwebjs_auth_${userId}`); }

function createClientForUser(userId) {
    if (clients[userId]) return;
    delete clientErrors[userId];
    delete qrCodes[userId];
    const chromeExecutable = chromeExecutablePath || prepareChromeForRuntime();
    if (!chromeExecutable) {
        clientErrors[userId] = chromePreparationError || 'Chrome indisponivel para abrir o WhatsApp';
        return;
    }
    const authPath = getUserAuthPath(userId);
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
    const puppeteerArgs = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
        '--no-first-run', '--no-zygote', '--single-process',
        '--disable-extensions', '--disable-background-networking'
    ];
    const puppeteerOpts = { headless: true, args: puppeteerArgs, executablePath: chromeExecutable };
    const client = new Client({ authStrategy: new LocalAuth({ dataPath: authPath }), puppeteer: puppeteerOpts });
    client.on('qr', (qr) => { qrCodes[userId] = qr; connectedUsers.delete(userId); });
    client.on('ready', () => { connectedUsers.add(userId); delete qrCodes[userId]; delete clientErrors[userId]; console.log(`[User ${userId}] Conectado`); });
    client.on('auth_failure', (msg) => {
        clientErrors[userId] = msg || 'Falha de autenticacao do WhatsApp';
        delete qrCodes[userId];
        connectedUsers.delete(userId);
        delete clients[userId];
        console.error(`[User ${userId}] Auth failure:`, msg || 'sem detalhes');
    });
    client.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us')) return;
        const body = (msg.body || '').toLowerCase().trim();
        const today = new Date().toISOString().split('T')[0];
        db.run("INSERT INTO messages (user_id, sender, msg, opt, ts, created_date) VALUES (?,?,?,?,datetime('now'),?)", [userId, msg.from, msg.body, body, today]);
        db.get("SELECT is_paused FROM users WHERE id=?", [userId], async (err, user) => {
            if (user?.is_paused) return;
            db.get("SELECT phone_number FROM blacklist WHERE user_id=? AND phone_number=?", [userId, msg.from], (err, blocked) => {
                if (blocked) return;
                db.all("SELECT response FROM keywords WHERE user_id=? AND keyword LIKE ?", [userId, `%${body}%`], async (err, kw) => {
                    if (kw?.length) { await msg.reply(kw[0].response); return; }
                    db.all("SELECT * FROM options WHERE user_id=?", [userId], async (err, opts) => {
                        const opt = opts?.find(o => o.key_num === body);
                        if (opt) { await msg.reply(opt.response); return; }
                        if (opts?.length > 0) {
                            const list = opts.map(o => `${o.key_num} - ${o.title}`).join('\n');
                            db.get("SELECT menu_message FROM configs WHERE user_id=?", [userId], async (err, cfg) => {
                                await msg.reply((cfg?.menu_message || 'Menu:').replace('{OPTIONS}', list));
                            });
                            return;
                        }
                        db.get("SELECT default_reply FROM configs WHERE user_id=?", [userId], async (err, cfg) => {
                            if (cfg?.default_reply) await msg.reply(cfg.default_reply);
                        });
                    });
                });
            });
        });
    });
    client.on('disconnected', (reason) => {
        if (reason && reason !== 'NAVIGATION') clientErrors[userId] = `Desconectado: ${reason}`;
        delete clients[userId];
        connectedUsers.delete(userId);
        delete qrCodes[userId];
    });
    clients[userId] = client;
    client.initialize().catch(err => {
        console.error(`[User ${userId}] Erro ao inicializar:`, err.message);
        clientErrors[userId] = err.message || 'Erro ao inicializar WhatsApp';
        delete clients[userId]; // volta para 'disconnected' para o usuario poder tentar novamente
        delete qrCodes[userId];
        connectedUsers.delete(userId);
    });
}

const isRender = process.env.RENDER === 'true';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'bot-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 3600000 } }));
app.use(express.static(path.join(basePath, 'public')));

const auth = (req, res, next) => { if (req.session?.user) return next(); res.status(401).json({ error: 'N�o autorizado' }); };
const adminAuth = (req, res, next) => { if (req.session?.user?.role === 'admin') return next(); res.status(403).json({ error: 'Acesso negado' }); };

app.post('/api/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username=?", [req.body.username], (err, user) => {
        if (user && bcrypt.compareSync(req.body.password, user.password_hash)) {
            req.session.user = { id: user.id, username: user.username, role: user.role };
            res.json({ success: true, username: user.username, role: user.role });
        } else {
            res.status(401).json({ error: 'Credenciais inv�lidas' });
        }
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get('/api/me', auth, (req, res) => { res.json(req.session.user); });
app.get('/api/users', auth, adminAuth, (req, res) => {
    db.all("SELECT id, username, role, is_paused, created_at FROM users", (err, rows) => {
        const result = (rows || []).map(u => ({ ...u, wa_connected: connectedUsers.has(u.id) }));
        res.json(result);
    });
});
app.post('/api/users', auth, adminAuth, (req, res) => {
    const { username, password } = req.body;
    if (!username || username.length < 3) return res.status(400).json({ error: 'M�nimo 3 caracteres' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'M�nimo 4 caracteres' });
    db.run("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,'user',datetime('now'))", [username, bcrypt.hashSync(password, 10)], function (err) {
        if (err) return res.status(400).json({ error: 'Usu�rio j� existe' });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/users/:id', auth, adminAuth, (req, res) => { db.run("DELETE FROM users WHERE id=?", [req.params.id], () => res.json({ success: true })); });
app.get('/api/config', auth, (req, res) => {
    const userId = req.query.user_id && req.session.user.role === 'admin' ? req.query.user_id : req.session.user.id;
    Promise.all([
        new Promise(r => db.get("SELECT * FROM configs WHERE user_id=?", [userId], (e, d) => r(d || {}))),
        new Promise(r => db.all("SELECT * FROM options WHERE user_id=?", [userId], (e, d) => r(d || []))),
        new Promise(r => db.all("SELECT * FROM keywords WHERE user_id=?", [userId], (e, d) => r(d || []))),
        new Promise(r => db.all("SELECT * FROM blacklist WHERE user_id=?", [userId], (e, d) => r(d || [])))
    ]).then(([cfg, opts, kw, bl]) => { res.json({ config: cfg, options: opts, keywords: kw, blacklist: bl }); });
});

app.post('/api/config', auth, (req, res) => {
    const { menu_message, default_reply } = req.body;
    db.get("SELECT id FROM configs WHERE user_id=?", [req.session.user.id], (err, cfg) => {
        if (cfg) {
            db.run("UPDATE configs SET menu_message=?, default_reply=? WHERE user_id=?", [menu_message, default_reply, req.session.user.id], () => res.json({ success: true }));
        } else {
            db.run("INSERT INTO configs (user_id, menu_message, default_reply) VALUES (?,?,?)", [req.session.user.id, menu_message, default_reply], () => res.json({ success: true }));
        }
    });
});

app.post('/api/options', auth, (req, res) => {
    db.run("INSERT INTO options (user_id, key_num, title, response) VALUES (?,?,?,?)", [req.session.user.id, req.body.key_num, req.body.title, req.body.response], function () { res.json({ success: true, id: this.lastID }); });
});

app.delete('/api/options/:id', auth, (req, res) => { db.run("DELETE FROM options WHERE id=? AND user_id=?", [req.params.id, req.session.user.id], () => res.json({ success: true })); });

app.post('/api/keywords', auth, (req, res) => {
    db.run("INSERT INTO keywords (user_id, keyword, response) VALUES (?,?,?)", [req.session.user.id, req.body.keyword, req.body.response], function () { res.json({ success: true, id: this.lastID }); });
});

app.delete('/api/keywords/:id', auth, (req, res) => { db.run("DELETE FROM keywords WHERE id=? AND user_id=?", [req.params.id, req.session.user.id], () => res.json({ success: true })); });

app.post('/api/blacklist', auth, (req, res) => {
    db.run("INSERT INTO blacklist (user_id, phone_number) VALUES (?,?)", [req.session.user.id, req.body.phone_number], function () { res.json({ success: true, id: this.lastID }); });
});

app.delete('/api/blacklist/:id', auth, (req, res) => { db.run("DELETE FROM blacklist WHERE id=? AND user_id=?", [req.params.id, req.session.user.id], () => res.json({ success: true })); });

app.get('/api/messages', auth, (req, res) => {
    const userId = req.query.user_id && req.session.user.role === 'admin' ? req.query.user_id : req.session.user.id;
    const today = new Date().toISOString().split('T')[0];
    db.all("SELECT * FROM messages WHERE user_id=? AND created_date=? ORDER BY id DESC LIMIT 200", [userId, today], (err, rows) => { res.json(rows || []); });
});

app.post('/api/pause', auth, (req, res) => { db.run("UPDATE users SET is_paused=1 WHERE id=?", [req.session.user.id], () => res.json({ success: true })); });
app.post('/api/resume', auth, (req, res) => { db.run("UPDATE users SET is_paused=0 WHERE id=?", [req.session.user.id], () => res.json({ success: true })); });

app.get('/api/ping', (req, res) => res.json({ ok: true }));

app.get('/api/qr', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const qr = qrCodes[req.session.user.id];
    if (!qr) return res.json({ qr: null });
    try { const url = await QRCode.toDataURL(qr, { width: 280, margin: 2 }); res.json({ qr: url }); }
    catch (e) { res.json({ qr: null }); }
});

app.get('/api/whatsapp/status', auth, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const uid = req.session.user.id;
    if (connectedUsers.has(uid)) return res.json({ status: 'connected' });
    if (qrCodes[uid]) return res.json({ status: 'qr' });
    if (clients[uid]) return res.json({ status: 'connecting' });
    if (clientErrors[uid]) return res.json({ status: 'error', message: clientErrors[uid] });
    res.json({ status: 'disconnected' });
});

app.get('/api/admin/stats', auth, adminAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    Promise.all([
        new Promise(r => db.get("SELECT COUNT(*) as c FROM users WHERE role='user'", (e, d) => r(d?.c || 0))),
        new Promise(r => db.get("SELECT COUNT(*) as c FROM messages WHERE created_date=?", [today], (e, d) => r(d?.c || 0)))
    ]).then(([users, msgs]) => res.json({ users, msgs, active: connectedUsers.size }));
});

app.get('/api/admin/messages', auth, adminAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const uid = req.query.user_id;
    const sql = uid
        ? "SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id=u.id WHERE m.user_id=? AND m.created_date=? ORDER BY m.id DESC LIMIT 500"
        : "SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id=u.id WHERE m.created_date=? ORDER BY m.id DESC LIMIT 500";
    const params = uid ? [uid, today] : [today];
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/:id/pause', auth, adminAuth, (req, res) => {
    db.run("UPDATE users SET is_paused=1 WHERE id=?", [req.params.id], () => res.json({ success: true }));
});
app.post('/api/admin/users/:id/resume', auth, adminAuth, (req, res) => {
    db.run("UPDATE users SET is_paused=0 WHERE id=?", [req.params.id], () => res.json({ success: true }));
});

app.post('/api/password', auth, (req, res) => {
    const { current, newpass } = req.body;
    db.get("SELECT * FROM users WHERE id=?", [req.session.user.id], (err, user) => {
        if (!user || !bcrypt.compareSync(current, user.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
        if (!newpass || newpass.length < 4) return res.status(400).json({ error: 'Minimo 4 caracteres' });
        db.run("UPDATE users SET password_hash=? WHERE id=?", [bcrypt.hashSync(newpass, 10), req.session.user.id], () => res.json({ success: true }));
    });
});

app.post('/api/whatsapp/init', auth, (req, res) => { createClientForUser(req.session.user.id); res.json({ success: true }); });

app.post('/api/whatsapp/logout', auth, async (req, res) => {
    const client = clients[req.session.user.id];
    if (client) { await client.logout().catch(() => { }); await client.destroy().catch(() => { }); delete clients[req.session.user.id]; }
    const authPath = getUserAuthPath(req.session.user.id);
    delete clientErrors[req.session.user.id];
    delete qrCodes[req.session.user.id];
    connectedUsers.delete(req.session.user.id);
    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
    res.json({ success: true });
});

app.post('/api/test-message', auth, (req, res) => {
    const client = clients[req.session.user.id];
    if (!client) return res.status(400).json({ error: 'WhatsApp nao conectado. Conecte primeiro.' });
    const phone = (req.body.to || req.body.phone || '').replace(/[^0-9]/g, '');
    client.sendMessage(`${phone}@c.us`, req.body.message).then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message }));
});

setInterval(() => { const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]; db.run("DELETE FROM messages WHERE created_date < ?", [yesterday]); }, 3600000);

app.get('/admin', (req, res) => { res.sendFile(path.join(basePath, 'public', 'index.html')); });

function startServer(port = process.env.PORT || 3000) {
    app.listen(port, () => { const host = isRender ? 'https://seu-bot.onrender.com' : `http://localhost:${port}`; console.log('\n? Bot: ' + host + '/admin\n'); }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') { startServer(port + 1); } else { setTimeout(() => startServer(port), 5000); }
    });
}

try {
    prepareChromeForRuntime();
    startServer();
} catch (err) { console.error('Erro:', err); process.exit(1); }
