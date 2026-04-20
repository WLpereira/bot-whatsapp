// Bot de WhatsApp com Admin Web - Opcoes Dinamicas
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Detectar se está rodando como executável pkg
const isPackaged = typeof process.pkg !== 'undefined';

// Definir basePath de forma segura
let basePath;
try {
    basePath = (typeof __dirname !== 'undefined' && __dirname) ? __dirname : process.cwd();
} catch (e) {
    basePath = process.cwd();
}

// Se estiver packaged e cwd tem bot-distribuicao na estrutura, usar cwd
if (isPackaged) {
    basePath = process.cwd();
}

const configPath = path.join(basePath, 'config.json');
const dbPath = path.join(basePath, 'data', 'db.sqlite');
const authPath = path.join(basePath, '.wwebjs_auth');

// Criar diretórios necessários
if (!fs.existsSync(path.join(basePath, 'data'))) {
    fs.mkdirSync(path.join(basePath, 'data'), { recursive: true });
}

if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
}

let config = {
    owner_number: '',
    menu_message: 'Ola! Seja bem-vindo!\n\nEscolha uma opcao:\n{OPTIONS}',
    options: [
        { key: '1', title: 'Comprar', response: 'Otimo! Me diga o que voce deseja comprar.', notify_owner: false },
        { key: '2', title: 'Falar com atendente', response: 'Um atendente ira falar com voce em breve.', notify_owner: true },
        { key: '3', title: 'Horario', response: 'Nosso horario e de segunda a sexta das 8h as 18h.', notify_owner: false }
    ],
    triggers: ['oi', 'ola', 'olá', 'menu', 'inicio', 'bom dia', 'boa tarde', 'boa noite'],
    default_reply: ''
};

if (fs.existsSync(configPath)) {
    try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (e) { }
}

function saveConfig() { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }

function buildMenuMessage() {
    const list = config.options.map(o => o.key + ' - ' + o.title).join('\n');
    return config.menu_message.replace('{OPTIONS}', list);
}

const db = new sqlite3.Database(dbPath);
db.serialize(function () {
    db.run('CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, created_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, sender TEXT, msg TEXT, opt TEXT, ts TEXT)');
    db.get("SELECT * FROM admins WHERE username='admin'", function (err, row) {
        if (!row) {
            db.run("INSERT INTO admins (username, password_hash, created_at) VALUES ('admin', ?, datetime('now'))", [bcrypt.hashSync('admin', 10)]);
            console.log('Admin criado: admin/admin');
        }
    });
});

// WhatsApp Client
let client = null;
let whatsappStatus = 'disconnected';
let clientInitializing = false;

function createClient() {
    if (clientInitializing) {
        console.log('WhatsApp já está inicializando...');
        return;
    }

    clientInitializing = true;
    whatsappStatus = 'connecting';

    try {
        client = new Client({
            authStrategy: new LocalAuth({ dataPath: authPath }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage'
                ]
            }
        });

        client.on('qr', function (qr) {
            whatsappStatus = 'qr';
            console.log('\n========================================');
            console.log('   ESCANEIE O QR CODE NO SEU CELULAR');
            console.log('========================================\n');
            qrcode.generate(qr, { small: true });
        });

        client.on('ready', function () {
            whatsappStatus = 'connected';
            clientInitializing = false;
            console.log('\n========================================');
            console.log('   BOT WHATSAPP CONECTADO!');
            console.log('========================================\n');
        });

        client.on('authenticated', function () {
            whatsappStatus = 'connected';
            clientInitializing = false;
            console.log('WhatsApp autenticado!');
        });

        client.on('auth_failure', function (msg) {
            whatsappStatus = 'error';
            clientInitializing = false;
            console.error('Falha auth:', msg);
        });

        client.on('disconnected', function (reason) {
            whatsappStatus = 'disconnected';
            clientInitializing = false;
            console.log('WhatsApp desconectado:', reason);
        });

        client.on('message', async function (message) {
            try {
                if (message.from.endsWith('@g.us')) return;
                var raw = message.body || '';
                var body = raw.toLowerCase().trim();
                console.log('Msg de ' + message.from + ': "' + raw + '"');
                if (!body) return;

                db.run("INSERT INTO messages (sender, msg, opt, ts) VALUES (?, ?, ?, datetime('now'))", [message.from, raw, body]);

                var isMenu = config.triggers.some(function (t) { return body.indexOf(t.toLowerCase()) >= 0; });
                if (isMenu) {
                    await client.sendMessage(message.from, buildMenuMessage());
                    return;
                }

                var opt = config.options.find(function (o) { return o.key === body; });
                if (opt) {
                    await client.sendMessage(message.from, opt.response);
                    if (opt.notify_owner && config.owner_number) {
                        await client.sendMessage(config.owner_number + '@c.us', '[' + opt.title + '] Cliente: ' + message.from.split('@')[0]);
                    }
                    return;
                }

                if (config.default_reply) {
                    await client.sendMessage(message.from, config.default_reply);
                }
            } catch (err) {
                console.error('Erro ao processar mensagem:', err.message);
            }
        });

        console.log('Inicializando WhatsApp...');
        client.initialize().catch(err => {
            console.error('Erro ao inicializar WhatsApp:', err.message);
            whatsappStatus = 'error';
            clientInitializing = false;
        });
    } catch (err) {
        console.error('Erro ao criar cliente WhatsApp:', err.message);
        whatsappStatus = 'error';
        clientInitializing = false;
    }

    // Inicializar WhatsApp automaticamente apenas se não estiver em Render
    const isRender = process.env.RENDER === 'true';
    if (!isRender) {
        console.log('Inicializando WhatsApp (modo local)...');
        createClient();
    } else {
        console.log('⏳ Modo Render detectado - WhatsApp inicializará sob demanda via painel admin');
    }
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'bot-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 3600000 } }));
    app.use(express.static(path.join(basePath, 'public')));

    function auth(req, res, next) {
        if (req.session && req.session.user) return next();
        res.status(401).json({ error: 'Nao autorizado' });
    }

    app.post('/api/login', function (req, res) {
        db.get("SELECT * FROM admins WHERE username = ?", [req.body.username], function (err, user) {
            if (user && bcrypt.compareSync(req.body.password, user.password_hash)) {
                req.session.user = { id: user.id, username: user.username };
                res.json({ success: true, username: user.username });
            } else {
                res.status(401).json({ error: 'Credenciais invalidas' });
            }
        });
    });

    app.post('/api/logout', function (req, res) {
        req.session.destroy(function () { res.json({ success: true }); });
    });

    app.get('/api/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

    app.get('/api/config', auth, function (req, res) { res.json(config); });

    app.post('/api/config', auth, function (req, res) {
        config = { ...config, ...req.body };
        saveConfig();
        res.json({ success: true });
    });

    app.get('/api/logs', auth, function (req, res) {
        db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 200", function (err, rows) { res.json(rows || []); });
    });

    app.post('/api/change-password', auth, function (req, res) {
        db.get("SELECT * FROM admins WHERE id = ?", [req.session.user.id], function (err, user) {
            if (user && bcrypt.compareSync(req.body.old_password, user.password_hash)) {
                db.run("UPDATE admins SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(req.body.new_password, 10), user.id]);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Senha incorreta' });
            }
        });
    });

    // ========== GERENCIAMENTO DE USUARIOS ==========

    // Listar todos usuarios
    app.get('/api/users', auth, function (req, res) {
        db.all("SELECT id, username, created_at FROM admins ORDER BY id", function (err, rows) {
            res.json(rows || []);
        });
    });

    // Criar novo usuario
    app.post('/api/users', auth, function (req, res) {
        var username = (req.body.username || '').trim();
        var password = req.body.password || '';

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'Nome de usuario deve ter pelo menos 3 caracteres' });
        }
        if (!password || password.length < 4) {
            return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
        }

        db.get("SELECT * FROM admins WHERE username = ?", [username], function (err, exists) {
            if (exists) {
                return res.status(400).json({ error: 'Usuario ja existe' });
            }
            db.run("INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, datetime('now'))",
                [username, bcrypt.hashSync(password, 10)], function (err) {
                    if (err) {
                        return res.status(500).json({ error: 'Erro ao criar usuario' });
                    }
                    res.json({ success: true, id: this.lastID });
                });
        });
    });

    // Atualizar nome do usuario
    app.put('/api/users/:id', auth, function (req, res) {
        var id = parseInt(req.params.id);
        var newUsername = (req.body.username || '').trim();

        if (!newUsername || newUsername.length < 3) {
            return res.status(400).json({ error: 'Nome de usuario deve ter pelo menos 3 caracteres' });
        }

        db.get("SELECT * FROM admins WHERE username = ? AND id != ?", [newUsername, id], function (err, exists) {
            if (exists) {
                return res.status(400).json({ error: 'Este nome de usuario ja existe' });
            }
            db.run("UPDATE admins SET username = ? WHERE id = ?", [newUsername, id], function (err) {
                if (err) {
                    return res.status(500).json({ error: 'Erro ao atualizar' });
                }
                // Se o usuario logado alterou seu proprio nome, atualizar sessao
                if (req.session.user.id === id) {
                    req.session.user.username = newUsername;
                }
                res.json({ success: true });
            });
        });
    });

    // Resetar senha do usuario
    app.post('/api/users/:id/reset-password', auth, function (req, res) {
        var id = parseInt(req.params.id);
        var newPassword = req.body.password || '';

        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
        }

        db.run("UPDATE admins SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(newPassword, 10), id], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Erro ao resetar senha' });
            }
            res.json({ success: true });
        });
    });

    // Deletar usuario (nao pode deletar a si mesmo)
    app.delete('/api/users/:id', auth, function (req, res) {
        var id = parseInt(req.params.id);

        if (req.session.user.id === id) {
            return res.status(400).json({ error: 'Voce nao pode deletar seu proprio usuario' });
        }

        db.run("DELETE FROM admins WHERE id = ?", [id], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Erro ao deletar' });
            }
            res.json({ success: true });
        });
    });

    // Obter usuario atual
    app.get('/api/me', auth, function (req, res) {
        res.json({ id: req.session.user.id, username: req.session.user.username });
    });

    // ========== STATUS WHATSAPP ==========
    app.get('/api/whatsapp/status', auth, function (req, res) {
        res.json({ status: whatsappStatus });
    });

    app.post('/api/whatsapp/logout', auth, async function (req, res) {
        try {
            if (client) {
                await client.logout();
                await client.destroy();
                client = null;
            }
            const authPath = path.join(basePath, '.wwebjs_auth');
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
            whatsappStatus = 'disconnected';
            console.log('WhatsApp deslogado! Sessao removida.');
            res.json({ success: true, message: 'WhatsApp deslogado. Reinicie o bot para gerar novo QR.' });
        } catch (err) {
            console.error('Erro ao deslogar:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/whatsapp/reconnect', auth, function (req, res) {
        try {
            if (client) {
                client.destroy();
                client = null;
            }
            whatsappStatus = 'connecting';
            console.log('Reconectando WhatsApp...');
            createClient();
            res.json({ success: true, message: 'Reconectando... Aguarde o QR code.' });
        } catch (err) {
            console.error('Erro ao reconectar:', err);
        });

    app.get('/admin', function (req, res) { res.sendFile(path.join(basePath, 'public', 'index.html')); });

    // Encontrar porta disponível
    function startServer(port = process.env.PORT || 3000) {
        const server = app.listen(port, function () {
            const host = process.env.RENDER ? 'https://seu-bot.onrender.com' : 'http://localhost:' + port;
            console.log('\n========================================');
            console.log('Admin UI: ' + host + '/admin');
            console.log('Login: admin / admin');
            console.log('========================================\n');
        }).on('error', function (err) {
            if (err.code === 'EADDRINUSE') {
                console.log('Porta ' + port + ' em uso, tentando ' + (port + 1) + '...');
                startServer(port + 1);
            } else {
                console.error('Erro ao iniciar servidor:', err);
                // Tentar novamente em 5 segundos
                setTimeout(() => startServer(port), 5000);
            }
        });
    }

    try {
        startServer();
    } catch (err) {
        console.error('Erro crítico ao iniciar:', err);
        process.exit(1);
    }
