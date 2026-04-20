# 🤖 Bot WhatsApp - Atendente Automático

Bot de WhatsApp com painel administrativo web para pequenos negócios. Totalmente customizável e distribuível como executável único.

## ✨ Características

- ✅ **Executável único** (~54 MB) - sem dependências externas
- ✅ **Funciona em máquina fraca** - Chromium compilado dentro
- ✅ **Painel web administrativo** - customize mensagens e opções
- ✅ **Menu interativo** - respostas automáticas por opção
- ✅ **Banco de dados SQLite** - histórico de conversas
- ✅ **Autenticação de admin** - controle de acesso
- ✅ **Atalho customizável** - com seu ícone

## 🚀 Quick Start

### Desenvolvimento

```bash
# Instalar dependências
npm install

# Rodar em desenvolvimento
npm start
```

Acesse: `http://localhost:3000/admin`  
Login: `admin / admin`

### Compilar para Executável

```bash
# Compilar com pkg
npm install -g pkg
npm run build:pkg

# Ou use os scripts batch
.\build-exe.bat
.\prep-distribution.bat
```

## 📦 Distribuição

A pasta `bot-distribuicao/` contém tudo pronto para distribuir:

```
bot-distribuicao/
├── INICIAR (atalho com ícone)
├── Run.bat (script de inicialização)
├── whatsapp-bot.exe (programa único)
├── config.json (configuração)
├── data/db.sqlite (banco de dados)
└── LEIA-ME.txt (instruções para usuário)
```

### Como distribuir para cliente:

1. Customize `config.json` (opcional)
2. Copie pasta `bot-distribuicao/`
3. Comprima em ZIP
4. Envie para cliente
5. Cliente extrai e clica em `INICIAR`

## 📋 Configuração

Edit `config.json`:

```json
{
  "owner_number": "55XXXXXXXXXXX",
  "menu_message": "Olá! Bem-vindo!\n\nEscolha uma opção:\n{OPTIONS}",
  "options": [
    {
      "key": "1",
      "title": "Comprar",
      "response": "Ótimo! Me diga o que deseja...",
      "notify_owner": false
    }
  ],
  "triggers": ["oi", "olá", "menu"],
  "default_reply": "Desculpe, não entendi."
}
```

## 🔧 Tecnologias

- **Node.js** 18.x
- **whatsapp-web.js** - Integração WhatsApp
- **Express.js** - Servidor web
- **SQLite3** - Banco de dados
- **pkg** - Compilação para executável

## 📖 API Endpoints

- `POST /api/login` - Autenticação
- `GET /api/config` - Obter configuração
- `POST /api/config` - Salvar configuração
- `GET /api/logs` - Histórico de mensagens
- `POST /api/change-password` - Mudar senha
- `GET /api/users` - Listar usuários admin
- `POST /api/users` - Criar usuário admin

## 🛡️ Segurança

- ✅ Senhas criptografadas com bcrypt
- ✅ Sessões HTTP com express-session
- ✅ Autenticação obrigatória em endpoints críticos
- ✅ Troque senha padrão (admin/admin)

## 📝 Estrutura do Projeto

```
bot-app-WLP/
├── index.js (aplicação principal)
├── config.json (configuração)
├── package.json
├── public/ (interface web)
├── data/ (banco de dados)
├── bot-distribuicao/ (pasta de distribuição)
├── build-exe.bat (script de compilação)
└── prep-distribution.bat (preparar distribuição)
```

## 🐛 Troubleshooting

### Porta 3000 em uso
O bot tenta automaticamente as próximas portas (3001, 3002...)

### QR Code não aparece
- Feche e execute novamente
- Atualize WhatsApp no celular
- Verifique internet

### Banco de dados vazio
Criado automaticamente na primeira execução

## 📦 Próximas Melhorias

- [ ] Dashboard de estatísticas
- [ ] Suporte a múltiplas conversas simultâneas
- [ ] Backup automático do banco de dados
- [ ] Integração com APIs externas
- [ ] Webinar/tutorial integrado

## 📄 Licença

MIT

## 👨‍💻 Desenvolvedor

Bot WhatsApp v1.0  
Pronto para produção

---

**Documentação rápida:**
- Ver [RESUMO-DISTRIBUICAO.txt](RESUMO-DISTRIBUICAO.txt) para detalhes de distribuição
- Ver [bot-distribuicao/LEIA-ME.txt](bot-distribuicao/LEIA-ME.txt) para instruções do usuário final
