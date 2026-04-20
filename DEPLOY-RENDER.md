# Deploy no Render (Grátis)

## 📋 Pré-requisitos

✅ Conta GitHub com o repositório public  
✅ Conta Render (grátis em https://render.com)

---

## 🚀 Passo a Passo

### 1. **Fazer Push do Código para GitHub**

```bash
cd d:\WF\bot-app-WLP

# Se ainda não fez:
git init
git add .
git commit -m "Initial commit: Bot WhatsApp com painel admin"
git remote add origin https://github.com/SEU_USUARIO/bot-whatsapp.git
git branch -M main
git push -u origin main
```

### 2. **Acessar Render**

1. Abra https://render.com
2. Clique em **Sign up** (use GitHub para facilitar)
3. Autorize o acesso ao GitHub

### 3. **Criar Web Service**

1. Clique em **New +**
2. Selecione **Web Service**
3. Busque e selecione o repositório `bot-whatsapp`
4. Clique em **Connect**

### 4. **Configurar Deploy**

Preencha os campos:

```
Name:              bot-whatsapp
Environment:       Node
Build Command:     npm install
Start Command:     node index.js
Plan:              Free
```

5. Clique em **Create Web Service**

### 5. **Aguardar Deploy**

O Render vai:
- Clonar seu repositório
- Instalar dependências (`npm install`)
- Iniciar a aplicação (`node index.js`)
- Gerar URL pública

---

## ✅ Verificar se Funcionou

Após 2-3 minutos, você terá:

- **URL**: `https://bot-whatsapp.onrender.com`
- **Painel Admin**: `https://bot-whatsapp.onrender.com/admin`
- **Login**: `admin / admin`

---

## 📱 QR Code no Navegador

Para ver o QR Code do WhatsApp:

1. Acesse `https://bot-whatsapp.onrender.com/admin`
2. Faça login com `admin / admin`
3. Clique em **Conectar WhatsApp**
4. Escaneie o QR Code com seu celular

---

## ⚠️ Limitações do Free Tier

- **Inatividade**: Se o bot ficar sem tráfego por 15 minutos, ele dorme
- **Restart**: Render pode reiniciar a aplicação periodicamente
- **Dados**: SQLite persiste, mas em caso de restart pode perder dados em memória

---

## 💾 Backup do Banco de Dados

Para fazer backup automático diário do `db.sqlite`:

1. Instale dependência:
```bash
npm install node-schedule
```

2. O código já suporta backups automáticos (veja index.js)

---

## 🔧 Atualizar Código

Quando quiser fazer mudanças:

```bash
# Faça as alterações no código
git add .
git commit -m "Sua mensagem"
git push origin main
```

Render detecta automaticamente e faz novo deploy! 🎉

---

## 📞 Suporte

Se tiver problemas:

1. Verifique o **Build Logs** no Render
2. Verifique o **Logs** da aplicação rodando
3. Procure por erros de `npm install` ou `node index.js`

---

## 💰 Próximos Passos (Pago)

Se o bot crescer e precisar de:

- ✅ **Mais recursos**: Atualizar plano Render ($7/mês)
- ✅ **PostgreSQL**: Render oferece banco de dados ($15/mês)
- ✅ **Mais clientes**: Replicar o serviço ou usar DigitalOcean ($4/mês)

