# Próximos passos — o que fazer, na ordem

Três coisas. A ordem importa: fazer na ordem errada quebra o site.

---

## 1️⃣ Baixar o plano do App Service

**Por quê:** o plano atual é `P0v4`, da linha Premium. Custa algo entre US$ 60 e 80 por mês. O `B1` faz o mesmo para este projeto por ~US$ 13. Com Premium, seus US$ 100 acabam antes do Demo Day.

**Como:**

1. Portal do Azure → busque **ihome-app**
2. Menu da esquerda → **Plano do Serviço de Aplicativo**
3. Clique em **Escalar verticalmente (Plano do Serviço de Aplicativo)**
4. Escolha a aba **Desenvolvimento/Teste** → **B1** → **Selecionar**

Não derruba o site. Só troca o tamanho da máquina por baixo.

> Se der erro de cota no B1, escolha **F1 (Gratuito)** por enquanto. O F1 dorme depois de 20 minutos parado — não serve para a apresentação, mas segura o gasto até resolvermos.

---

## 2️⃣ Configurar as variáveis de ambiente

**Por quê:** o código novo precisa delas. Sem `JWT_SECRET`, nenhum login funciona. Sem `DATABASE_URL`, a API não conecta ao banco.

**⚠️ Faça isto ANTES do passo 3.** Se o código novo subir sem as variáveis, o site quebra.

**Como:**

1. Portal → **ihome-app** → menu esquerda → **Configurações** → **Variáveis de ambiente**
2. Para cada linha abaixo, clique em **+ Adicionar**, preencha Nome e Valor
3. No final, clique em **Aplicar** e confirme

| Nome | Valor |
|---|---|
| `JWT_SECRET` | *gere — instruções abaixo* |
| `ENCRYPTION_KEY` | *gere — instruções abaixo* |
| `DATABASE_URL` | *a string de conexão do seu banco* |
| `FRONTEND_URL` | *a URL do seu frontend* |
| `BACKEND_URL` | `https://ihome-app-ffa2cgh4ghbecwda.westcentralus-01.azurewebsites.net` |
| `GEMINI_API_KEY` | *sua chave do Gemini* |
| `GMAIL_USER` | *seu e-mail* |
| `GMAIL_APP_PASSWORD` | *senha de app do Gmail* |
| `NODE_ENV` | `production` |

### Como gerar os dois segredos

Abra o [Cloud Shell](https://shell.azure.com) e rode **duas vezes**:

```
openssl rand -hex 32
```

Cada execução dá um código de 64 caracteres. Use o primeiro para `JWT_SECRET` e o segundo para `ENCRYPTION_KEY`.

> ⚠️ **Guarde os dois num lugar seguro fora do Azure** — bloco de notas, gerenciador de senhas, o que preferir.
>
> - Trocar `JWT_SECRET` desconecta todos os usuários.
> - Perder `ENCRYPTION_KEY` torna as credenciais Tuya guardadas **impossíveis de recuperar**.

### Como achar a `DATABASE_URL`

Portal → seu servidor PostgreSQL → **Cadeias de conexão** → copie a de **Node.js**.

O formato é:

```
postgresql://USUARIO:SENHA@SERVIDOR.postgres.database.azure.com:5432/ihome?sslmode=require
```

Troque `SENHA` pela senha que você definiu ao criar o banco, e confirme que o nome do banco no final é o correto.

Se o banco recusar a conexão depois, é firewall: servidor PostgreSQL → **Rede** → marque **Permitir acesso público de serviços do Azure**.

---

## 3️⃣ Enviar o código novo

**Por quê:** o que está no ar hoje é o código de antes de toda a reformulação. As telas de login e de auditoria simplesmente não existem lá — `/auth/login` responde 404.

**Como:** abra o terminal na pasta do backend e rode, uma linha por vez:

```
git pull
git add .
git commit -m "feat: autenticacao propria, auditoria, seguranca e Node 24"
git push
```

Depois, na pasta do frontend, os mesmos quatro comandos.

O `git pull` traz o arquivo que o Azure criou no seu GitHub. Se ele reclamar de conflito, me manda o que apareceu.

Assim que o push terminar, o GitHub Actions roda sozinho: 224 testes no backend, 49 no frontend, e o deploy para o Azure. Dá para acompanhar na aba **Actions** do repositório.

---

## Como saber se deu certo

Abra no navegador:

```
https://ihome-app-ffa2cgh4ghbecwda.westcentralus-01.azurewebsites.net/health
```

**Hoje** responde: `{"ok":true,"push":false}`

**Depois de tudo pronto** deve responder: `{"ok":true,"push":true}`

E este endereço, que hoje dá erro 404, deve passar a existir:

```
https://ihome-app-ffa2cgh4ghbecwda.westcentralus-01.azurewebsites.net/auth/me
```

Ele vai responder `{"error":"Token não fornecido"}` — o que está **certo**. Significa que a rota existe e está protegida.

---

## O que ainda falta depois disso

- [ ] Conectar o frontend à API (variável `REACT_APP_API_URL` no build)
- [ ] Publicar a Wiki no GitHub (instruções em `wiki/PUBLICAR.md`)
- [ ] **Marcar as duas orientações** — prazo 30/09
