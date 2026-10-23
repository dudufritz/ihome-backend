# O que falta para o app funcionar

> **Reescrito em 19/10/2026.** A versão anterior descrevia a infraestrutura de
> setembro, que não existe mais. Em 09/10 todos os recursos que geravam custo
> foram excluídos — o App Service Premium, o PostgreSQL na camada Uso Geral, a
> rede virtual e as zonas DNS — depois de uma cobrança de R$ 586,17 que o plano
> estudantil não cobria. O que existe agora foi recriado **dentro das camadas
> gratuitas**, e o desenho mudou junto.

## Infraestrutura atual

| Recurso | Tipo | Camada | Região |
|---|---|---|---|
| `ihome-api-2026` | App Service — a API | **Gratuito F1** | West US 3 |
| `ASP-Ihome-a371` | Plano do App Service | **Gratuito F1** | West US 3 |
| `ihome-db-2026` | PostgreSQL Flexible — o banco | **Intermitente B1ms**, 32 GiB | Canada Central |
| `ihome-front` | Static Web App — o site | Free | East US 2 |

**Endereços**

- Site — **`https://ihomeauto.com`** (também responde em
  `https://ambitious-water-08155590f.5.azurestaticapps.net`)
- API — `https://ihome-api-2026-cxc9fwdzhcddb6cg.westus3-01.azurewebsites.net`
- Banco — `ihome-db-2026.postgres.database.azure.com`

O domínio é servido pelo DNS da Vercel (gratuito), com `ALIAS` na raiz e
`CNAME` no `www` apontando para o Static Web App. A delegação ficou quebrada
entre 09/10 e 19/10 porque os nameservers apontavam para a zona DNS do Azure
que havia sido excluída na contenção de custo.

Como a API valida a origem das requisições pelo `FRONTEND_URL`, os dois
endereços precisam estar liberados: o domínio em `FRONTEND_URL` e o
`.azurestaticapps.net` em `CORS_EXTRA_ORIGINS`. Trocar um sem o outro derruba
o login com um erro de CORS que não aparece no log do servidor, só no console
do navegador.

### Duas consequências da mudança que o código precisa respeitar

**1. O banco agora é de acesso público, não mais private endpoint.**

A rede virtual e o endpoint privado foram excluídos, e recriá-los não cabe no
gratuito. O `ihome-db-2026` usa **Acesso público** com duas regras de firewall:
"permitir serviços do Azure" (é assim que o App Service chega nele) e o IP da
máquina de desenvolvimento. O método de conectividade é fixado na criação do
servidor — não dá para voltar atrás sem recriar.

Isso é menos isolado do que o desenho anterior, e vale registrar como tal: a
porta 5432 só aceita conexões das origens listadas no firewall, mas a camada de
rede deixou de ser uma barreira e a autenticação passou a ser a única. Para um
projeto acadêmico de usuário único é aceitável; num sistema real a VNet volta.

**2. O plano F1 não tem "Always On".**

A API hiberna depois de ~20 minutos sem requisição e leva alguns segundos para
responder a primeira chamada depois disso. Duas implicações:

- Antes de qualquer apresentação, abra a URL da API uma vez para acordá-la.
- O `scheduler.job.js` só executa enquanto o processo está vivo. Com o site
  dormindo, rotinas agendadas podem não disparar no horário. É uma limitação
  real da camada gratuita, não um defeito do código — e é exatamente o tipo de
  coisa que um plano pago (B1, "Always On" ligado) resolve.

---

## 1️⃣ Variáveis de ambiente do App Service

Portal → **ihome-api-2026** → **Configurações → Variáveis de ambiente** →
**Configurações do aplicativo**.

| Nome | Valor | Sem ela |
|---|---|---|
| `NODE_ENV` | `production` | o SSL do banco não é ativado |
| `DATABASE_URL` | veja abaixo | a API não acessa o banco |
| `JWT_SECRET` | 64 caracteres aleatórios | nenhum login funciona |
| `ENCRYPTION_KEY` | 64 caracteres hexadecimais | segredos Tuya ficam em texto puro |
| `FRONTEND_URL` | `https://ihomeauto.com` | o site é bloqueado pelo CORS |
| `CORS_EXTRA_ORIGINS` | o `.azurestaticapps.net` e o `www`, separados por vírgula | esses endereços são bloqueados |
| `BACKEND_URL` | o endereço da API | links de e-mail saem errados |
| `GEMINI_API_KEY` | sua chave do Google AI Studio | assistente desativado |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | par gerado pelo `web-push` | notificações push desativadas |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | opcional | convites por e-mail não são enviados |

Gerar os segredos, cada comando uma vez:

```bash
npm run gen:key                               # JWT_SECRET e ENCRYPTION_KEY
npx web-push generate-vapid-keys              # par VAPID
```

> ⚠️ **Guarde os dois primeiros fora do Azure.** Trocar o `JWT_SECRET`
> desconecta todo mundo. Perder o `ENCRYPTION_KEY` torna as credenciais Tuya já
> cifradas impossíveis de recuperar.

### Sobre a `DATABASE_URL`

```
postgresql://ihomeadmin:SENHA@ihome-db-2026.postgres.database.azure.com:5432/postgres?sslmode=require
```

O `env.js` exige o formato URI. O Azure às vezes injeta a string no formato
ADO.NET (`Server=...;Database=...`), que o driver `pg` não entende — o próprio
boot avisa quando isso acontece.

O banco `postgres` já vem criado no servidor e é suficiente: o `db/schema.js`
cria todas as tabelas na primeira subida, com `IF NOT EXISTS`.

### Como saber se deu certo

```
https://ihome-api-2026-cxc9fwdzhcddb6cg.westus3-01.azurewebsites.net/health
```

```json
{
  "ok": true,
  "push": true,
  "config": {
    "database": true,
    "auth": true,
    "frontendUrl": true,
    "ai": true,
    "email": false
  }
}
```

Qualquer `false` aponta exatamente qual variável faltou.

---

## 2️⃣ Secret de publicação no GitHub

O workflow `main_ihome-app.yml` publica em `ihome-api-2026` e lê o secret
`AZUREAPPSERVICE_PUBLISHPROFILE`.

1. Portal → **ihome-api-2026** → **Visão geral** → **Baixar perfil de
   publicação**
2. GitHub → `ihome-backend` → **Settings → Secrets and variables → Actions** →
   **New repository secret** com esse nome e o XML inteiro como valor
3. Apague o secret antigo `AZUREAPPSERVICE_PUBLISHPROFILE_B31046…` — aponta
   para um recurso que não existe mais

---

## 3️⃣ Primeiro acesso

O banco é novo e está **vazio**: não há contas, dispositivos nem histórico.

1. Abra o site e **crie a conta de novo**
2. Em **Configurações**, cole as credenciais Tuya (Access ID e Access Secret)
   para os dispositivos voltarem a aparecer

---

## Pendências

- [ ] `/health` com os `config` em `true`
- [ ] Login funcionando no endereço do Static Web App
- [x] `ihomeauto.com` de volta no ar, pelo DNS da Vercel, sem custo
- [ ] Renovação do domínio em 08/06/2027 (US$ 11,25): o método de pagamento na
      Vercel está incompleto desde o cancelamento do cartão. Sem corrigir, o
      domínio expira
- [ ] PR #4 do backend, ainda aberto
- [ ] Publicar a Wiki — instruções em [`wiki/PUBLICAR.md`](wiki/PUBLICAR.md)
