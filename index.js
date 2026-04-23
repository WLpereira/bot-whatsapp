const { Client, RemoteAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    console.error('[Process] UnhandledRejection:', msg);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] UncaughtException:', err && err.message ? err.message : err);
});

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
const appRole = process.env.APP_ROLE === 'worker' ? 'worker' : 'web';
const isWorkerRole = appRole === 'worker';
const workerInstanceId = process.env.WORKER_ID || `${process.env.RENDER_SERVICE_NAME || 'worker'}-${process.pid}`;

const dataDir = path.join(runtimeBasePath, '.wwebjs_auth');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function getUserSessionId(userId) {
    return `user-${userId}`;
}

function parseUserIdFromSessionName(sessionName) {
    const match = /^RemoteAuth-user-(\d+)$/.exec(sessionName || '');
    return match ? parseInt(match[1], 10) : null;
}

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

async function ensureSessionRecord(userId) {
    await db.run(
        `INSERT INTO wa_sessions (user_id, session_name, connected, last_update)
         VALUES ($1, $2, 0, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET session_name = EXCLUDED.session_name`,
        [userId, `RemoteAuth-${getUserSessionId(userId)}`]
    );
}

const remoteSessionStore = {
    async sessionExists({ session }) {
        const userId = parseUserIdFromSessionName(session);
        if (!userId) return false;
        const row = await db.get('SELECT session_blob FROM wa_sessions WHERE user_id=$1', [userId]);
        return Boolean(row?.session_blob);
    },
    async save({ session }) {
        const userId = parseUserIdFromSessionName(session);
        if (!userId) throw new Error(`Sessao invalida: ${session}`);
        const zipPath = `${session}.zip`;
        const sessionBlob = await fs.promises.readFile(zipPath);
        await ensureSessionRecord(userId);
        await db.run(
            `UPDATE wa_sessions
             SET session_blob=$1, session_name=$2, last_update=NOW()
             WHERE user_id=$3`,
            [sessionBlob, session, userId]
        );
    },
    async extract({ session, path: destinationPath }) {
        const userId = parseUserIdFromSessionName(session);
        if (!userId) throw new Error(`Sessao invalida: ${session}`);
        const row = await db.get('SELECT session_blob FROM wa_sessions WHERE user_id=$1', [userId]);
        if (!row?.session_blob) throw new Error(`Sessao nao encontrada para ${session}`);
        await fs.promises.writeFile(destinationPath, row.session_blob);
    },
    async delete({ session }) {
        const userId = parseUserIdFromSessionName(session);
        if (!userId) return;
        await db.run(
            `UPDATE wa_sessions
             SET session_blob=NULL, connected=0, last_update=NOW()
             WHERE user_id=$1`,
            [userId]
        );
    }
};

async function hasStoredSession(userId) {
    const row = await db.get('SELECT session_blob IS NOT NULL AS has_session FROM wa_sessions WHERE user_id=$1', [userId]);
    return Boolean(row?.has_session);
}

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
            session_name VARCHAR(255),
            session_blob BYTEA,
            connected INTEGER DEFAULT 0,
            desired_state VARCHAR(50) DEFAULT 'disconnected',
            status VARCHAR(50) DEFAULT 'disconnected',
            status_message TEXT,
            last_error TEXT,
            qr_code TEXT,
            pairing_code VARCHAR(50),
            phone_number VARCHAR(30),
            worker_host VARCHAR(255),
            updated_at TIMESTAMP DEFAULT NOW(),
            last_update TIMESTAMP DEFAULT NOW()
        )`);

        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS session_name VARCHAR(255)');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS session_blob BYTEA');
        await db.run("ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS desired_state VARCHAR(50) DEFAULT 'disconnected'");
        await db.run("ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'disconnected'");
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS status_message TEXT');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS last_error TEXT');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS qr_code TEXT');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS pairing_code VARCHAR(50)');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30)');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS worker_host VARCHAR(255)');
        await db.run('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()');

        await db.run(`CREATE TABLE IF NOT EXISTS wa_jobs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            job_type VARCHAR(50) NOT NULL,
            payload JSONB DEFAULT '{}'::jsonb,
            status VARCHAR(30) DEFAULT 'pending',
            result JSONB,
            error_text TEXT,
            locked_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);

        const admin = await db.get("SELECT * FROM users WHERE role='admin'");
        if (!admin) {
            await db.run(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, NOW())",
                ['admin', bcrypt.hashSync('admin', 10), 'admin']
            );
        }

        const allUsers = await db.all('SELECT id FROM users');
        for (const user of allUsers) {
            await ensureSessionRecord(user.id);
        }

        console.log('[Boot] Banco de dados inicializado com sucesso');
        dbReady = true;
    } catch (err) {
        console.error('[Boot] Erro ao inicializar banco de dados:', err.message);
        dbReady = true;
    }
}

async function patchWaSession(userId, changes) {
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (!entries.length) return;

    const assignments = entries.map(([key], index) => `${key}=$${index + 2}`);
    const values = entries.map(([, value]) => value);

    assignments.push(`updated_at=NOW()`, `last_update=NOW()`);

    await db.run(
        `UPDATE wa_sessions SET ${assignments.join(', ')} WHERE user_id=$1`,
        [userId, ...values]
    );
}

async function getWaSession(userId) {
    return db.get('SELECT * FROM wa_sessions WHERE user_id=$1', [userId]);
}

async function enqueueWaJob(userId, jobType, payload = {}) {
    const result = await db.run(
        `INSERT INTO wa_jobs (user_id, job_type, payload, status, updated_at)
         VALUES ($1, $2, $3::jsonb, 'pending', NOW())
         RETURNING id`,
        [userId, jobType, JSON.stringify(payload)]
    );
    return result.rows[0]?.id;
}

async function claimNextWaJob() {
    const result = await db.query(
        `WITH next_job AS (
            SELECT id
            FROM wa_jobs
            WHERE status='pending'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE wa_jobs AS jobs
        SET status='running', locked_by=$1, updated_at=NOW()
        FROM next_job
        WHERE jobs.id = next_job.id
        RETURNING jobs.*`,
        [workerInstanceId]
    );
    return result.rows[0] || null;
}

async function finishWaJob(jobId, status, details = {}) {
    await db.run(
        `UPDATE wa_jobs
         SET status=$2,
             result=$3::jsonb,
             error_text=$4,
             updated_at=NOW()
         WHERE id=$1`,
        [jobId, status, JSON.stringify(details.result || {}), details.error || null]
    );
}

const clients = {};
const qrCodes = {};
const pairingCodes = {};
const pairingJobs = {};
const connectedUsers = new Set();
const clientErrors = {};
const clientStates = {};

function setClientState(userId, status, message) {
    clientStates[userId] = { status, message: message || null, updatedAt: Date.now() };
}

async function createClientForUser(userId) {
    if (clients[userId]) return;
    await ensureSessionRecord(userId);
    delete clientErrors[userId];
    delete qrCodes[userId];
    delete pairingCodes[userId];
    setClientState(userId, 'connecting', 'Abrindo sessao do WhatsApp...');
    if (pool) await patchWaSession(userId, {
        desired_state: 'connected',
        status: 'connecting',
        status_message: 'Abrindo sessao do WhatsApp...',
        last_error: null,
        qr_code: null,
        pairing_code: null,
        worker_host: workerInstanceId
    });

    const chromeExecutable = chromeExecutablePath || prepareChromeForRuntime();
    if (!chromeExecutable) {
        clientErrors[userId] = chromePreparationError || 'Chrome indisponivel para abrir o WhatsApp';
        setClientState(userId, 'error', clientErrors[userId]);
        if (pool) await patchWaSession(userId, {
            status: 'error',
            status_message: clientErrors[userId],
            last_error: clientErrors[userId],
            connected: 0
        });
        return;
    }

    const puppeteerArgs = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
        '--no-first-run', '--no-zygote',
        '--disable-extensions', '--disable-background-networking',
        '--mute-audio',
        '--no-default-browser-check'
    ];

    const puppeteerOpts = {
        headless: true,
        args: puppeteerArgs,
        executablePath: chromeExecutable,
        timeout: 120000,
        protocolTimeout: 120000
    };

    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: getUserSessionId(userId),
            dataPath: dataDir,
            store: remoteSessionStore,
            backupSyncIntervalMs: 60000
        }),
        puppeteer: puppeteerOpts,
        takeoverOnConflict: true,
        authTimeoutMs: 180000,
        qrMaxRetries: 0
    });

    client.on('qr', (qr) => {
        qrCodes[userId] = qr;
        delete pairingCodes[userId];
        connectedUsers.delete(userId);
        setClientState(userId, 'qr', 'Escaneie o QR Code no WhatsApp');
        if (pool) {
            patchWaSession(userId, {
                status: 'qr',
                status_message: 'Escaneie o QR Code no WhatsApp',
                qr_code: qr,
                pairing_code: null,
                connected: 0,
                last_error: null,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });
    client.on('code', (code) => {
        pairingCodes[userId] = code;
        delete pairingJobs[userId];
        delete qrCodes[userId];
        setClientState(userId, 'pairing_code', 'Use o codigo no WhatsApp para conectar');
        console.log(`[User ${userId}] Codigo de pareamento: ${code}`);
        if (pool) {
            patchWaSession(userId, {
                status: 'pairing_code',
                status_message: 'Use o codigo no WhatsApp para conectar',
                qr_code: null,
                pairing_code: code,
                connected: 0,
                last_error: null,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });
    client.on('authenticated', () => {
        delete qrCodes[userId];
        delete pairingCodes[userId];
        delete pairingJobs[userId];
        setClientState(userId, 'authenticated', 'WhatsApp autenticado. Finalizando conexao...');
        if (pool) {
            patchWaSession(userId, {
                status: 'authenticated',
                status_message: 'WhatsApp autenticado. Finalizando conexao...',
                qr_code: null,
                pairing_code: null,
                connected: 0,
                last_error: null,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });
    client.on('loading_screen', (percent, message) => {
        const text = message ? `${message} (${percent}%)` : `Carregando (${percent}%)`;
        setClientState(userId, 'connecting', text);
        if (pool) {
            patchWaSession(userId, {
                status: 'connecting',
                status_message: text,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });
    client.on('change_state', async (state) => {
        if (state === 'CONNECTED') {
            connectedUsers.add(userId);
            setClientState(userId, 'connected', 'Conectado');
            try {
                if (pool) await patchWaSession(userId, {
                    connected: 1,
                    desired_state: 'connected',
                    status: 'connected',
                    status_message: 'Conectado',
                    qr_code: null,
                    pairing_code: null,
                    last_error: null,
                    worker_host: workerInstanceId
                });
            } catch (e) { }
            return;
        }

        if (state === 'OPENING' || state === 'PAIRING') {
            setClientState(userId, 'connecting', `Conectando ao WhatsApp (${state})...`);
            if (pool) {
                patchWaSession(userId, {
                    status: 'connecting',
                    status_message: `Conectando ao WhatsApp (${state})...`,
                    worker_host: workerInstanceId
                }).catch(() => { });
            }
        }
    });
    client.on('ready', async () => { connectedUsers.add(userId); delete qrCodes[userId]; delete pairingCodes[userId]; delete pairingJobs[userId]; delete clientErrors[userId]; setClientState(userId, 'connected', 'Conectado'); try { if (pool) await patchWaSession(userId, { connected: 1, desired_state: 'connected', status: 'connected', status_message: 'Conectado', qr_code: null, pairing_code: null, last_error: null, worker_host: workerInstanceId }); } catch (e) { } console.log(`[User ${userId}] Conectado`); });
    client.on('remote_session_saved', async () => {
        try {
            if (pool) await db.run("UPDATE wa_sessions SET last_update=NOW() WHERE user_id=$1", [userId]);
        } catch (e) { }
        console.log(`[User ${userId}] Sessao remota salva`);
    });
    client.on('auth_failure', (msg) => { clientErrors[userId] = msg || 'Falha de autenticacao do WhatsApp'; delete qrCodes[userId]; delete pairingCodes[userId]; delete pairingJobs[userId]; connectedUsers.delete(userId); delete clients[userId]; setClientState(userId, 'error', clientErrors[userId]); if (pool) { patchWaSession(userId, { connected: 0, status: 'error', status_message: clientErrors[userId], last_error: clientErrors[userId], qr_code: null, pairing_code: null, worker_host: workerInstanceId }).catch(() => { }); } });

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
        delete pairingCodes[userId];
        delete pairingJobs[userId];
        setClientState(userId, clientErrors[userId] ? 'error' : 'disconnected', clientErrors[userId] || 'Desconectado');
        if (pool) {
            patchWaSession(userId, {
                connected: 0,
                status: clientErrors[userId] ? 'error' : 'disconnected',
                status_message: clientErrors[userId] || 'Desconectado',
                last_error: clientErrors[userId] || null,
                qr_code: null,
                pairing_code: null,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });

    clients[userId] = client;
    client.initialize().catch(err => {
        console.error(`[User ${userId}] Erro ao inicializar:`, err.message);
        clientErrors[userId] = err.message || 'Erro ao inicializar WhatsApp';
        setClientState(userId, 'error', clientErrors[userId]);
        delete clients[userId];
        delete qrCodes[userId];
        delete pairingCodes[userId];
        delete pairingJobs[userId];
        connectedUsers.delete(userId);
        if (pool) {
            patchWaSession(userId, {
                connected: 0,
                status: 'error',
                status_message: clientErrors[userId],
                last_error: clientErrors[userId],
                qr_code: null,
                pairing_code: null,
                worker_host: workerInstanceId
            }).catch(() => { });
        }
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestPairingCodeForUser(userId, phone) {
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    if (!phoneDigits || phoneDigits.length < 10) {
        throw new Error('Numero invalido. Use formato internacional, ex: 5511999999999');
    }

    if (pairingJobs[userId]) {
        return { pending: true, code: pairingCodes[userId] || null };
    }

    await createClientForUser(userId);
    const client = clients[userId];
    if (!client) throw new Error('Cliente WhatsApp indisponivel');

    pairingJobs[userId] = true;
    setClientState(userId, 'pairing_pending', 'Gerando codigo de pareamento...');
    console.log(`[User ${userId}] Iniciando geracao de codigo para ${phoneDigits}`);

    (async () => {
        let lastError = null;
        try {
            // Da alguns segundos para o cliente inicializar totalmente no Render
            await wait(8000);

            for (let i = 0; i < 6; i++) {
                if (pairingCodes[userId]) return;
                try {
                    const liveClient = clients[userId];
                    if (!liveClient) {
                        throw new Error('Cliente nao inicializado para pareamento');
                    }

                    const code = await Promise.race([
                        liveClient.requestPairingCode(phoneDigits, true, 180000),
                        wait(25000).then(() => { throw new Error('timeout'); })
                    ]);
                    if (code) {
                        pairingCodes[userId] = code;
                        setClientState(userId, 'pairing_code', 'Use o codigo no WhatsApp para conectar');
                        console.log(`[User ${userId}] Codigo gerado com sucesso`);
                        return;
                    }
                } catch (e) {
                    lastError = e && e.message ? e.message : String(e);

                    // Alguns ambientes/versoes nao suportam PairingCodeLinkUtils.
                    // Nesses casos, fazemos fallback para QR automaticamente.
                    if (lastError.includes('PairingCodeLinkUtils')) {
                        console.warn(`[User ${userId}] Pareamento por codigo indisponivel; usando QR.`);
                        setClientState(userId, 'qr', 'Conexao por codigo indisponivel aqui. Use o QR Code.');
                        return;
                    }

                    console.warn(`[User ${userId}] Tentativa ${i + 1}/6 falhou ao gerar codigo: ${lastError}`);

                    // Se cliente caiu durante tentativas, tenta recriar automaticamente
                    if (!clients[userId]) {
                        try {
                            await createClientForUser(userId);
                        } catch (recreateErr) {
                            const recreateMsg = recreateErr && recreateErr.message ? recreateErr.message : String(recreateErr);
                            console.warn(`[User ${userId}] Falha ao recriar cliente: ${recreateMsg}`);
                        }
                    }
                    await wait(3000);
                }
            }

            if (!pairingCodes[userId]) {
                const detail = lastError ? ` Motivo: ${lastError}` : '';
                setClientState(userId, 'error', `Nao foi possivel gerar codigo.${detail}`);
                console.error(`[User ${userId}] Falha final ao gerar codigo.${detail}`);
            }
        } finally {
            delete pairingJobs[userId];
        }
    })();

    return { pending: true, code: pairingCodes[userId] || null };
}

async function autoReconnectSavedSessions() {
    try {
        if (!dbReady || !pool) {
            console.log('[Boot] Banco nao disponivel, pulando auto-reconexao');
            return;
        }
        console.log('[Boot] Verificando sessoes salvas...');
        const sessions = await db.all("SELECT user_id FROM wa_sessions WHERE connected=1 OR session_blob IS NOT NULL");
        if (!sessions || sessions.length === 0) return;
        for (const s of sessions) {
            console.log(`[Boot] Auto-reconectando user ${s.user_id}`);
            await createClientForUser(s.user_id);
        }
    } catch (err) {
        console.error('[Boot] Erro ao auto-reconectar:', err.message);
    }
}

let workerLoopHandle = null;
let workerJobRunning = false;

async function processWaJob(job) {
    const payload = job.payload || {};
    const userId = job.user_id;

    if (job.job_type === 'connect') {
        await patchWaSession(userId, {
            desired_state: 'connected',
            status: 'connecting',
            status_message: 'Solicitacao de conexao recebida',
            last_error: null,
            worker_host: workerInstanceId
        });
        await createClientForUser(userId);
        await finishWaJob(job.id, 'done', { result: { accepted: true } });
        return;
    }

    if (job.job_type === 'disconnect') {
        const client = clients[userId];
        if (client) {
            await client.logout().catch(() => { });
            await client.destroy().catch(() => { });
            delete clients[userId];
        }
        delete clientErrors[userId];
        delete qrCodes[userId];
        delete pairingCodes[userId];
        delete pairingJobs[userId];
        connectedUsers.delete(userId);
        setClientState(userId, 'disconnected', 'Desconectado');
        await patchWaSession(userId, {
            desired_state: 'disconnected',
            connected: 0,
            status: 'disconnected',
            status_message: 'Desconectado',
            last_error: null,
            qr_code: null,
            pairing_code: null,
            session_blob: null,
            worker_host: workerInstanceId
        });
        await finishWaJob(job.id, 'done', { result: { disconnected: true } });
        return;
    }

    if (job.job_type === 'send_message') {
        let client = clients[userId];
        if (!client && await hasStoredSession(userId)) {
            await createClientForUser(userId);
            client = clients[userId];
        }
        if (!client) {
            throw new Error('WhatsApp nao conectado. Conecte primeiro.');
        }

        const phone = String(payload.phone || '').replace(/[^0-9]/g, '');
        await client.sendMessage(`${phone}@c.us`, payload.message);
        await finishWaJob(job.id, 'done', { result: { sent: true } });
        return;
    }

    await finishWaJob(job.id, 'failed', { error: `Tipo de job desconhecido: ${job.job_type}` });
}

async function runWorkerLoop() {
    if (!isWorkerRole || workerJobRunning) return;
    workerJobRunning = true;
    try {
        const job = await claimNextWaJob();
        if (!job) return;
        try {
            await processWaJob(job);
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            await patchWaSession(job.user_id, {
                status: 'error',
                status_message: message,
                last_error: message,
                worker_host: workerInstanceId
            }).catch(() => { });
            await finishWaJob(job.id, 'failed', { error: message });
        }
    } finally {
        workerJobRunning = false;
    }
}

function startWorkerLoop() {
    if (!isWorkerRole || workerLoopHandle) return;
    workerLoopHandle = setInterval(() => {
        runWorkerLoop().catch((err) => {
            console.error('[Worker] Loop error:', err.message);
        });
    }, 2000);
    runWorkerLoop().catch((err) => {
        console.error('[Worker] Initial loop error:', err.message);
    });
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
        const users = await db.all("SELECT u.id, u.username, u.role, u.is_paused, u.created_at, s.connected, s.status, s.status_message FROM users u LEFT JOIN wa_sessions s ON s.user_id=u.id");
        const result = users.map(u => ({ ...u, wa_connected: Boolean(u.connected), wa_status: { status: u.status || 'disconnected', message: u.status_message || null } }));
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
        await ensureSessionRecord(result.rows[0].id);
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
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = parseInt(req.params.id);
        await enqueueWaJob(userId, 'connect', {});
        await patchWaSession(userId, { desired_state: 'connected', status: 'queued', status_message: 'Reconexao enfileirada', last_error: null });
        res.json({ success: true, message: 'Reconexao enfileirada.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/disconnect', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = parseInt(req.params.id);
        await enqueueWaJob(userId, 'disconnect', {});
        await patchWaSession(userId, { desired_state: 'disconnected', status: 'queued', status_message: 'Desconexao enfileirada' });
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
    const session = await getWaSession(req.session.user.id);
    const qr = session?.qr_code;
    if (!qr) return res.json({ qr: null });
    try { const url = await QRCode.toDataURL(qr, { width: 280, margin: 2 }); res.json({ qr: url }); } catch (e) { res.json({ qr: null }); }
});

app.get('/api/whatsapp/status', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const uid = req.session.user.id;
    const session = await getWaSession(uid);
    if (!session) return res.json({ status: 'disconnected' });
    if (session.pairing_code) return res.json({ status: 'pairing_code', code: session.pairing_code, message: session.status_message });
    if (session.qr_code) return res.json({ status: 'qr', message: session.status_message });
    if (session.status) return res.json({ status: session.status, message: session.status_message, connected: Boolean(session.connected) });
    res.json({ status: session.connected ? 'connected' : 'disconnected', message: session.status_message });
});

app.post('/api/whatsapp/init', auth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        await ensureSessionRecord(userId);
        await enqueueWaJob(userId, 'connect', {});
        await patchWaSession(userId, { desired_state: 'connected', status: 'queued', status_message: 'Solicitacao de conexao enfileirada', last_error: null });
        res.json({ success: true, queued: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whatsapp/pairing-code', auth, async (req, res) => {
    try {
        if (!isWorkerRole) {
            return res.status(400).json({ error: 'Conexao por codigo deve ser feita pelo worker WhatsApp. Use QR no painel web.' });
        }
        const userId = req.session.user.id;
        const phone = req.body.phone || req.body.number;
        const result = await requestPairingCodeForUser(userId, phone);
        res.json({ success: true, pending: true, code: result.code || null });
    } catch (err) {
        const msg = err && err.message ? err.message : 'Erro ao gerar codigo';
        if (msg.includes('PairingCodeLinkUtils')) {
            return res.status(400).json({ error: 'Conexao por codigo indisponivel neste ambiente. Use o QR Code.' });
        }
        res.status(500).json({ error: msg });
    }
});

app.post('/api/whatsapp/logout', auth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const userId = req.session.user.id;
        await enqueueWaJob(userId, 'disconnect', {});
        await patchWaSession(userId, { desired_state: 'disconnected', status: 'queued', status_message: 'Desconexao enfileirada' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/test-message', auth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const phone = (req.body.to || req.body.phone || '').replace(/[^0-9]/g, '');
        await enqueueWaJob(userId, 'send_message', { phone, message: req.body.message });
        res.json({ success: true, queued: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', auth, adminAuth, async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Banco nao disponivel' });
        const today = new Date().toISOString().split('T')[0];
        const userCount = await db.get("SELECT COUNT(*) as c FROM users WHERE role='user'");
        const msgCount = await db.get("SELECT COUNT(*) as c FROM messages WHERE created_date=$1", [today]);
        const activeCount = await db.get("SELECT COUNT(*) as c FROM wa_sessions WHERE connected=1");
        res.json({ users: userCount.c, msgs: msgCount.c, active: activeCount.c });
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
        await initDatabase();
        if (isWorkerRole) {
            prepareChromeForRuntime();
            await autoReconnectSavedSessions();
            startWorkerLoop();
            console.log(`[Boot] Worker WhatsApp ativo: ${workerInstanceId}`);
            if (process.env.WORKER_PORT) startServer(process.env.WORKER_PORT);
            return;
        }

        console.log('[Boot] API/Painel iniciados em modo web');
        startServer();
    } catch (err) {
        console.error('Erro no boot:', err);
        process.exit(1);
    }
})();
