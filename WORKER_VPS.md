# Worker WhatsApp na VPS

Este projeto agora roda em dois papéis:

- `web`: painel/API no Render
- `worker`: sessão do WhatsApp em uma VPS ou instância com mais RAM

O `worker` precisa usar o mesmo `DATABASE_URL` do painel web.

## 1. Preparar a VPS

Exemplo abaixo para Ubuntu 22.04 ou 24.04.

```bash
sudo apt update
sudo apt install -y curl git ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. Instalar dependências do Chromium

```bash
sudo apt install -y \
  libgbm1 libasound2 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libglib2.0-0 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1
```

## 3. Baixar o projeto

```bash
git clone https://github.com/WLpereira/bot-whatsapp.git
cd bot-whatsapp
npm install
```

## 4. Configurar ambiente do worker

Crie o arquivo `.env.worker`:

```env
APP_ROLE=worker
NODE_ENV=production
DATABASE_URL=postgresql://USUARIO:SENHA@HOST:5432/BANCO
```

Observações:

- use exatamente o mesmo `DATABASE_URL` do Render
- não defina `RENDER=true` na VPS
- se quiser expor HTTP de apoio no worker, adicione `WORKER_PORT=3001`

## 5. Testar o worker manualmente

No Linux:

```bash
export $(grep -v '^#' .env.worker | xargs)
npm run start:worker
```

Sinais esperados no log:

- `[DB] PostgreSQL conectado com sucesso`
- `[Boot] Worker WhatsApp ativo:`

Quando um usuário clicar em `Conectar WhatsApp` no painel, o worker deve pegar o job e gerar status/QR no banco.

## 6. Subir como serviço com PM2

```bash
sudo npm install -g pm2
export $(grep -v '^#' .env.worker | xargs)
pm2 start "npm run start:worker" --name whatsapp-worker
pm2 save
pm2 startup
```

Para ver logs:

```bash
pm2 logs whatsapp-worker
```

Para reiniciar:

```bash
pm2 restart whatsapp-worker
```

## 7. Checklist de validação

1. O painel no Render abre normalmente.
2. O login funciona.
3. Ao clicar em `Conectar WhatsApp`, o status muda para `queued` ou `connecting`.
4. Com o worker ativo, o endpoint `/api/qr` passa a devolver o QR do usuário.
5. Depois da leitura do QR, o status muda para `connected`.

## 8. Problemas comuns

`Banco nao disponivel`:

- confira `DATABASE_URL`
- confirme que a VPS consegue acessar o banco

`QR Code nao disponivel ainda`:

- veja se o worker está rodando
- confira os logs do PM2
- verifique se existe job pendente em `wa_jobs`

`Erro ao iniciar WhatsApp`:

- confirme as bibliotecas do Chromium
- confirme memória suficiente na VPS
- reinicie o worker após atualizar dependências