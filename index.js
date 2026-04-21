const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
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

let pool = null;
let dbReady = false;

function initPool() {
    if (pool) return pool;
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.warn('[Boot] DATABASE_URL nao definido, banco sera desabilitado');
        return null;
    }
    pool = new Pool({
        connectionString: dbUrl,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    pool.on('error', (err) => {
        console.error('[DB] Erro no pool:', err.message);
    });
    return pool;
}

const db = {
    async query(sql, params = []) {
        const p = pool || initPool();
        if (!p) throw new Error('Banco de dados nao disponivel');
        const client = await p.connect();
        try {
            const result = await client.query(sql, params);
            return result;
        } finally {
            client.release();
        }
    },
    async get(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0] || null;
    },
    async all(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    },
    async run(sql, params = []) {
        const result = await this.query(sql, params);
        return result;
    }
};

async function initDatabase() {
    try {
        if (!pool && !process.env.DATABASE_URL) {
            console.warn('[Boot] DATABASE_URL nao definido - banco desabilitado');
            dbReady = true;
            return;
        }
        initPool();
        console.log('[Boot] Inicializando banco de dados PostgreSQL...');

        await db.run(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'user',
            is_paused INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS configs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            menu_message TEXT,
            default_reply TEXT
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS options (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            key_num VARCHAR(10),
            title VARCHAR(255),
            response TEXT
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS keywords (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            keyword VARCHAR(255),
            response TEXT
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS blacklist (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            phone_number VARCHAR(20)
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            sender VARCHAR(50),
            msg TEXT,
            opt VARCHAR(255),
            ts TIMESTAMP DEFAULT NOW(),
            created_date DATE DEFAULT CURRENT_DATE
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS wa_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            session_data TEXT,
            connected INTEGER DEFAULT 0,
            last_update TIMESTAMP DEFAULT NOW()
        )`);

        const admin = await db.get("SELECT * FROM users WHERE role='admin'");
        if (!admin) {
            await db.run(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, NOW())",
                ['admin', bcrypt.hashSync('admin', 10), 'admin']
            );
        }

        console.log('[Boot] Banco de dados inicializado com sucesso');
        dbReady = true;
    } catch (err) {
        console.error('[Boot] Erro ao inicializar banco de dados:', err.message);
        dbReady = true;
    }
}

const clients = {};
const qrCodes = {};
const connectedUsers = new Set();
const clientErrors = {};
const clientStates = {};
const dataDir = path.join(runtimeBasePath, '.wwebjs_auth');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function setClientState(userId, status, message) {
    clientStates[userId] = { status, message: message || null, updatedAt: Date.now() };
}

function getUserAuthPath(userId) {
    return path.join(dataDir, `.wwebjs_auth_${userId}`);
}

async function createClientForUser(userId) {
    if (clients[userId]) return;
    delete clientErrors[userId];
    delete qrCodes[userId];
    setClientState(userId, 'connecting', 'Abrindo sessao do WhatsApp...');

    const chromeExecutable = chromeExecutablePath || prepareChromeForRuntime();
    if (!chromeExecutable) {
        clientErrors[userId] = chromePreparationError || 'Chrome indisponivel para abrir o WhatsApp';
        setClientState(userId, 'error', clientErrors[userId]);
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

    client.on('qr', (qr) => { qrCodes[userId] = qr; connectedUsers.delete(userId); setClientState(userId, 'qr', 'Escaneie o QR Code no WhatsApp'); });
    client.on('authenticated', () => { delete qrCodes[userId]; setClientState(userId, 'authenticated', 'WhatsApp autenticado. Finalizando conexao...'); });
    client.on('loading_screen', (percent, message) => { const text = message ? `${message} (${percent}%)` : `Carregando (${percent}%)`; setClientState(userId, 'connecting', text); });
    client.on('ready', async () => { connectedUsers.add(userId); delete qrCodes[userId]; delete clientErrors[userId]; setClientState(userId, 'connected', 'Conectado'); try { if (pool) await db.run("UPDATE wa_sessions SET connected=1, last_update=NOW() WHERE user_id=$1", [userId]); } catch (e) { } console.log(`[User ${userId}] Conectado`); });
    client.on('auth_failure', (msg) => { clientErrors[userId] = msg || 'Falha de autenticacao do WhatsApp'; delete qrCodes[userId]; connectedUsers.delete(userId); delete clients[userId]; setClientState(userId, 'error', clientErrors[userId]); });

    client.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us')) return;
        const body = (msg.body || '').toLowerCase().trim();
        const today = new Date().toISOString().split('T')[0];
        try {
            if (pool) await db.run("INSERT INTO messages (user_id, sender, msg, opt, created_date) VALUES ($1,$2,$3,$4,$5)", [userId, msg.from, msg.body, body, today]);
        } catch (e) { }

        try {
            if (!pool) return;
            const user = await db.get("SELECT is_paused FROM users WHERE id=$1", [userId]);
            if (user?.is_paused) return;
            const blocked = await db.get("SELECT phone_number FROM blacklist WHERE user_id=$1 AND phone_number=$2", [userId, msg.from]);
            if (blocked) return;
            const kw = await db.all("SELECT response FROM keywords WHERE user_id=$1 AND keyword LIKE $2", [userId, `%${body}%`]);
            if (kw?.length) { await msg.reply(kw[0].response); return; }
            const opts = await db.all("SELECT * FROM options WHERE user_id=$1", [userId]);
            const opt = opts?.find(o => o.key_num === body);
            if (opt) { await msg.reply(opt.response); return; }
            if (opts?.length > 0) {
                const list = opts.map(o => `${o.key_num} - ${o.title}`).join('\n');
                const cfg = await db.get("SELECT menu_message FROM configs WHERE user_id=$1", [userId]);
                await msg.reply((cfg?.menu_message || 'Menu:').replace('{OPTIONS}', list));
                return;
            }
            const cfg = await db.get("SELECT default_reply FROM configs WHERE user_id=$1", [userId]);
            if (cfg?.default_reply) await msg.reply(cfg.default_reply);
        } catch (e) { console.error('Erro ao processar mensagem:', e.message); }
    });

    client.on('disconnected', (reason) => {
        if (reason && reason !== 'NAVIGATION') clientErrors[userId] = `Desconectado: ${reason}`;
        delete clients[userId];
        connectedUsers.delete(userId);
        delete qrCodes[userId];
        setClientState(userId, clientErrors[userId] ? 'error' : 'disconnected', clientErrors[userId] || 'Desconectado');
    });

    clients[userId] = client;
    client.initialize().catch(err => {
        console.error(`[User ${userId}] Erro ao inicializar:`, err.message);
        clientErrors[userId] = err.message || 'Erro ao inicializar WhatsApp';
        setClientState(userId, 'error', clientErrors[userId]);
        delete clients[userId];
        delete qrCodes[userId];
        connectedUsers.delete(userId);
    });
}

async function autoReconnectSavedSessions() {
    try {
        if (!dbReady || !pool) {
            console.log('[Boot] Banco nao disponivel, pulando auto-reconexao');
            return;
        }
        console.log('[Boot] Verificando sessoes salvas...');
        const sessions = await db.all("SELECT user_id FROM wa_sessions WHERE connected=1");
        if (!sessions || sessions.length === 0) return;
        for (const s of sessions) {
            const authPath = getUserAuthPath(s.user_id);
            if (fs.existsSync(authPath)) {
                console.log(`[Boot] Auto-reconectando user ${s.user_id}`);
                await createClientForUser(s.user_id);
            }
        }
    } catch (err) {
        console.error('[Boot] Erro ao auto-reconectar:', err.message);
    }
}

const isRender = process.env.RENDER === 'true';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'bot-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 3600000 } }));
app.use(express.static(path.join(basePath, 'public')));

const auth = (req, res, next) => { if (req.session?.user) return next(); res.status(401).json({ error: 'Nao autorizado' }); };
const adminAuth = (req, res, next) => { if (req.session?.user?.role === 'admin') return next(); res.status(403).json({ error: 'Acesso negado' }); };

app.post('/api/login', async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const user = await db.get("SELECT * FROM users WHERE username=$1", [req.body.username]);
        if (user && bcrypt.compareSync(req.body.password, user.password_hash)) {
            req.session.user = { id: user.id, username: user.username, role: user.role };
            res.json({ success: true, username: user.username, role: user.role });
        } else {
            res.status(401).json({ error: 'Credenciais invÃ¡lidas' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get('/api/me', auth, (req, res) => { res.json(req.session.user); });

app.get('/api/users', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const users = await db.all("SELECT id, username, role, is_paused, created_at FROM users");
        const result = users.map(u => ({ ...u, wa_connected: connectedUsers.has(u.id), wa_status: clientStates[u.id] || { status: 'disconnected' } }));
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const { username, password } = req.body;
        if (!username || username.length < 3) return res.status(400).json({ error: 'MÃ­nimo 3 caracteres' });
        if (!password || password.length < 4) return res.status(400).json({ error: 'MÃ­nimo 4 caracteres' });
        const result = await db.run("INSERT INTO users (username, password_hash, role, created_at) VALUES ($1,$2,'user',NOW()) RETURNING id", [username, bcrypt.hashSync(password, 10)]);
        await db.run("INSERT INTO wa_sessions (user_id, connected) VALUES ($1, 0)", [result.rows[0].id]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') res.status(400).json({ error: 'UsuÃ¡rio jÃ¡ existe' });
        else res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', auth, adminAuth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("DELETE FROM users WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/reconnect', auth, adminAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (clients[userId]) { await clients[userId].logout().catch(() => { }); await clients[userId].destroy().catch(() => { }); delete clients[userId]; }
        connectedUsers.delete(userId); delete qrCodes[userId]; delete clientErrors[userId];
        await createClientForUser(userId);
        res.json({ success: true, message: 'Reconectando...' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/disconnect', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = parseInt(req.params.id);
        if (clients[userId]) { await clients[userId].logout().catch(() => { }); await clients[userId].destroy().catch(() => { }); delete clients[userId]; }
        const authPath = getUserAuthPath(userId);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        connectedUsers.delete(userId); delete qrCodes[userId]; delete clientErrors[userId];
        setClientState(userId, 'disconnected', 'Desconectado');
        await db.run("UPDATE wa_sessions SET connected=0, last_update=NOW() WHERE user_id=$1", [userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = req.query.user_id && req.session.user.role === 'admin' ? req.query.user_id : req.session.user.id;
        const config = await db.get("SELECT * FROM configs WHERE user_id=$1", [userId]);
        const options = await db.all("SELECT * FROM options WHERE user_id=$1", [userId]);
        const keywords = await db.all("SELECT * FROM keywords WHERE user_id=$1", [userId]);
        const blacklist = await db.all("SELECT * FROM blacklist WHERE user_id=$1", [userId]);
        res.json({ config: config || {}, options: options || [], keywords: keywords || [], blacklist: blacklist || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/config', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const { menu_message, default_reply } = req.body;
        const userId = req.session.user.id;
        const cfg = await db.get("SELECT id FROM configs WHERE user_id=$1", [userId]);
        if (cfg) {
            await db.run("UPDATE configs SET menu_message=$1, default_reply=$2 WHERE user_id=$3", [menu_message, default_reply, userId]);
        } else {
            await db.run("INSERT INTO configs (user_id, menu_message, default_reply) VALUES ($1,$2,$3)", [userId, menu_message, default_reply]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/options', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const result = await db.run("INSERT INTO options (user_id, key_num, title, response) VALUES ($1,$2,$3,$4) RETURNING id", [req.session.user.id, req.body.key_num, req.body.title, req.body.response]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/options/:id', auth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("DELETE FROM options WHERE id=$1 AND user_id=$2", [req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/keywords', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const result = await db.run("INSERT INTO keywords (user_id, keyword, response) VALUES ($1,$2,$3) RETURNING id", [req.session.user.id, req.body.keyword, req.body.response]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/keywords/:id', auth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("DELETE FROM keywords WHERE id=$1 AND user_id=$2", [req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/blacklist', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const result = await db.run("INSERT INTO blacklist (user_id, phone_number) VALUES ($1,$2) RETURNING id", [req.session.user.id, req.body.phone_number]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/blacklist/:id', auth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("DELETE FROM blacklist WHERE id=$1 AND user_id=$2", [req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = req.query.user_id && req.session.user.role === 'admin' ? req.query.user_id : req.session.user.id;
        const today = new Date().toISOString().split('T')[0];
        const messages = await db.all("SELECT * FROM messages WHERE user_id=$1 AND created_date=$2 ORDER BY id DESC LIMIT 200", [userId, today]);
        res.json(messages);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pause', auth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("UPDATE users SET is_paused=1 WHERE id=$1", [req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/resume', auth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("UPDATE users SET is_paused=0 WHERE id=$1", [req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/pause', auth, adminAuth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("UPDATE users SET is_paused=1 WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/resume', auth, adminAuth, async (req, res) => {
    try { if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' }); await db.run("UPDATE users SET is_paused=0 WHERE id=$1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/qr', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const qr = qrCodes[req.session.user.id];
    if (!qr) return res.json({ qr: null });
    try { const url = await QRCode.toDataURL(qr, { width: 280, margin: 2 }); res.json({ qr: url }); } catch (e) { res.json({ qr: null }); }
});

app.get('/api/whatsapp/status', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const uid = req.session.user.id;
    const authPath = getUserAuthPath(uid);
    if (!clients[uid] && !clientErrors[uid] && fs.existsSync(authPath)) await createClientForUser(uid);
    if (connectedUsers.has(uid)) return res.json({ status: 'connected' });
    if (qrCodes[uid]) return res.json({ status: 'qr' });
    if (clientStates[uid]) return res.json(clientStates[uid]);
    if (clients[uid]) return res.json({ status: 'connecting', message: 'Abrindo sessao do WhatsApp...' });
    if (clientErrors[uid]) return res.json({ status: 'error', message: clientErrors[uid] });
    res.json({ status: 'disconnected' });
});

app.post('/api/whatsapp/init', auth, async (req, res) => {
    try { await createClientForUser(req.session.user.id); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whatsapp/logout', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = req.session.user.id;
        if (clients[userId]) { await clients[userId].logout().catch(() => { }); await clients[userId].destroy().catch(() => { }); delete clients[userId]; }
        const authPath = getUserAuthPath(userId);
        delete clientErrors[userId]; delete qrCodes[userId];
        connectedUsers.delete(userId);
        setClientState(userId, 'disconnected', 'Desconectado');
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        await db.run("UPDATE wa_sessions SET connected=0, last_update=NOW() WHERE user_id=$1", [userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/test-message', auth, async (req, res) => {
    try {
        const client = clients[req.session.user.id];
        if (!client) return res.status(400).json({ error: 'WhatsApp nao conectado. Conecte primeiro.' });
        const phone = (req.body.to || req.body.phone || '').replace(/[^0-9]/g, '');
        await client.sendMessage(`${phone}@c.us`, req.body.message);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const today = new Date().toISOString().split('T')[0];
        const userCount = await db.get("SELECT COUNT(*) as c FROM users WHERE role='user'");
        const msgCount = await db.get("SELECT COUNT(*) as c FROM messages WHERE created_date=$1", [today]);
        res.json({ users: userCount.c, msgs: msgCount.c, active: connectedUsers.size });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/messages', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const today = new Date().toISOString().split('T')[0];
        const uid = req.query.user_id;
        let messages;
        if (uid) {
            messages = await db.all("SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id=u.id WHERE m.user_id=$1 AND m.created_date=$2 ORDER BY m.id DESC LIMIT 500", [uid, today]);
        } else {
            messages = await db.all("SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id=u.id WHERE m.created_date=$1 ORDER BY m.id DESC LIMIT 500", [today]);
        }
        res.json(messages);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/password', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const { current, newpass } = req.body;
        const user = await db.get("SELECT * FROM users WHERE id=$1", [req.session.user.id]);
        if (!user || !bcrypt.compareSync(current, user.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
        if (!newpass || newpass.length < 4) return res.status(400).json({ error: 'Minimo 4 caracteres' });
        await db.run("UPDATE users SET password_hash=$1 WHERE id=$2", [bcrypt.hashSync(newpass, 10), req.session.user.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/admin', (req, res) => { res.sendFile(path.join(basePath, 'public', 'index.html')); });

setInterval(async () => {
    try {
        if (!pool) return;
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        await db.run("DELETE FROM messages WHERE created_date < $1", [yesterday]);
    } catch (err) { }
}, 3600000);

function startServer(port = process.env.PORT || 3000) {
    app.listen(port, () => { const host = isRender ? 'https://seu-bot.onrender.com' : `http://localhost:${port}`; console.log('\n? Bot: ' + host + '/admin\n'); }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') { startServer(port + 1); } else { setTimeout(() => startServer(port), 5000); }
    });
}

(async () => {
    try {
        prepareChromeForRuntime();
        await initDatabase();
        await autoReconnectSavedSessions();
        startServer();
    } catch (err) {
        console.error('Erro no boot:', err);
        process.exit(1);
    }
})();
