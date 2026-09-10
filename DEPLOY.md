# Deploy do iHome no Azure — caminho gerenciado (PaaS)

> ⚠️ **Este não é o caminho em uso.** O deploy de produção do iHome roda numa
> VM — ver **[infra/VM.md](infra/VM.md)**.
>
> Este documento descreve a alternativa com serviços gerenciados (App Service +
> PostgreSQL Flexible + Static Web Apps). Foi preterido por custo: ~US$ 33/mês
> em East US contra ~US$ 20 da VM, o que faz os US$ 100 de crédito estudantil
> durarem 3 meses em vez de 5 — e são 3,5 meses até o Demo Day.
>
> Fica registrado porque é a alternativa que foi de fato avaliada, e porque
> uma decisão sem alternativa considerada não é decisão.

Passo a passo do provisionamento e da publicação. Os comandos usam o **Azure CLI** (`az`) — se preferir o portal, a ordem e os nomes dos recursos são os mesmos.

> **Crédito de estudante:** inscrevendo-se no [GitHub Student Developer Pack](https://education.github.com/pack), a Microsoft libera **US$ 100 em créditos Azure sem exigir cartão de crédito**. Os recursos abaixo cabem nesse valor com folga.

---

## 1. Arquitetura de destino

```
                    ┌──────────────────────────┐
   navegador  ───►  │  Azure Static Web Apps   │   React 18 · PWA
                    │  (CDN global, HTTPS)     │
                    └───────────┬──────────────┘
                                │ HTTPS / REST + JWT
                                ▼
                    ┌──────────────────────────┐
                    │  Azure App Service       │   Node.js 24 · Express
                    │  (container Linux)       │   imagem vinda do ACR
                    └───────────┬──────────────┘
                                │ TLS
                                ▼
                    ┌──────────────────────────┐
                    │  Azure Database for      │  11 tabelas · multi-tenant
                    │  PostgreSQL Flexible     │
                    └──────────────────────────┘

   Integrações externas: Tuya IoT · Google Gemini · Gmail SMTP · Web Push
```

---

## 2. Variáveis usadas nos comandos

Defina uma vez no seu terminal e os comandos seguintes funcionam copiando e colando.

```bash
export RG=ihome-rg                      # resource group
export LOCAL=eastus                     # Brazil South custa ~60% mais
export ACR=ihomeacr$RANDOM              # nome do registry (precisa ser único no Azure)
export APP=ihome-api-$RANDOM            # nome do App Service (vira a URL)
export PLANO=ihome-plan
export PG=ihome-db-$RANDOM              # servidor PostgreSQL
export PG_USER=ihomeadmin
export PG_PASS='troque-por-uma-senha-forte'
export SWA=ihome-web                    # Static Web Apps
```

Guarde os valores de `$ACR`, `$APP`, `$PG` e `$SWA` — serão pedidos adiante.

---

## 3. Provisionamento

### 3.1 Login e grupo de recursos

```bash
az login
az group create --name $RG --location $LOCAL
```

O *resource group* é apenas um agrupamento lógico. A vantagem prática: `az group delete --name $RG` apaga tudo de uma vez se você precisar recomeçar.

### 3.2 Container Registry

```bash
az acr create --resource-group $RG --name $ACR --sku Basic --admin-enabled true
```

É o repositório privado das imagens Docker. O SKU Basic (~US$ 5/mês) é suficiente: 10 GB de armazenamento.

### 3.3 Banco de dados

```bash
az postgres flexible-server create \
  --resource-group $RG \
  --name $PG \
  --location $LOCAL \
  --admin-user $PG_USER \
  --admin-password "$PG_PASS" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0

az postgres flexible-server db create \
  --resource-group $RG --server-name $PG --database-name ihome
```

Sobre `--tier Burstable`: a instância acumula créditos de CPU quando está ociosa e os gasta em picos. É o modelo mais barato e adequado a um app com uso intermitente.

Sobre `--public-access 0.0.0.0`: libera acesso a partir de serviços do Azure. **Não** é "aberto para a internet inteira" — mas também não é uma rede privada. Para o TCC é aceitável; a evolução seria colocar o banco numa VNet com Private Endpoint.

### 3.4 App Service

```bash
# Plano Linux B1 — 1 vCPU, 1,75 GB de RAM
az appservice plan create \
  --resource-group $RG --name $PLANO --sku B1 --is-linux

az webapp create \
  --resource-group $RG --plan $PLANO --name $APP \
  --deployment-container-image-name $ACR.azurecr.io/ihome-backend:latest

# Permite que o App Service puxe imagens do seu registry
az webapp config container set \
  --resource-group $RG --name $APP \
  --container-registry-url https://$ACR.azurecr.io \
  --container-registry-user $(az acr credential show -n $ACR --query username -o tsv) \
  --container-registry-password $(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)
```

### 3.5 Variáveis de ambiente da API

```bash
# Gere os segredos ANTES e guarde-os em lugar seguro
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)

az webapp config appsettings set --resource-group $RG --name $APP --settings \
  NODE_ENV=production \
  WEBSITES_PORT=3001 \
  DATABASE_URL="postgresql://$PG_USER:$PG_PASS@$PG.postgres.database.azure.com:5432/ihome?sslmode=require" \
  JWT_SECRET="$JWT_SECRET" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  BACKEND_URL="https://$APP.azurewebsites.net" \
  FRONTEND_URL="https://SEU-SWA.azurestaticapps.net" \
  GMAIL_USER="seu-email@gmail.com" \
  GMAIL_APP_PASSWORD="senha-de-app-do-gmail" \
  GEMINI_API_KEY="sua-chave-do-gemini" \
  VAPID_PUBLIC_KEY="..." \
  VAPID_PRIVATE_KEY="..." \
  NEW_RELIC_LICENSE_KEY="..." \
  NEW_RELIC_APP_NAME="iHome API" \
  RATE_LIMIT_WINDOW_MIN=15 \
  RATE_LIMIT_GLOBAL=300 \
  RATE_LIMIT_AUTH=10 \
  RATE_LIMIT_AI=30 \
  INVITE_EXPIRY_DAYS=7
```

`WEBSITES_PORT=3001` é obrigatório: é assim que o App Service descobre em qual porta o container escuta.

`FRONTEND_URL` também alimenta a allowlist do CORS. Se estiver errada, o navegador bloqueia todas as chamadas do frontend — e o erro aparece só no console do usuário, não nos logs da API. Confira depois de criar o Static Web Apps.

> ⚠️ **`JWT_SECRET` e `ENCRYPTION_KEY` não podem ser perdidas.** Trocar a primeira desconecta todos os usuários; perder a segunda torna os segredos Tuya já cifrados irrecuperáveis. Guarde-as fora do repositório — no Azure Key Vault, num gerenciador de senhas, em qualquer lugar menos no Git.

### 3.6 Static Web Apps

```bash
az staticwebapp create \
  --resource-group $RG --name $SWA --location eastus2 --sku Free
```

O plano Free do Static Web Apps atende de sobra: 100 GB de banda por mês e HTTPS com certificado gerenciado. A região do SWA é independente do resto — o conteúdo é servido por CDN global de qualquer forma.

---

## 4. Segredos do GitHub Actions

Em cada repositório: **Settings → Secrets and variables → Actions → New repository secret**.

### Repositório `ihome-backend`

| Secret | Como obter |
|---|---|
| `AZURE_CREDENTIALS` | `az ad sp create-for-rbac --name ihome-ci --role contributor --scopes /subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG --sdk-auth` — cole o JSON inteiro |
| `ACR_NAME` | o valor de `$ACR` (só o nome, sem `.azurecr.io`) |
| `AZURE_WEBAPP_NAME` | o valor de `$APP` |
| `SONAR_TOKEN` | gerado em sonarcloud.io → My Account → Security |

### Repositório `ihome-frontend`

| Secret | Como obter |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | `az staticwebapp secrets list --name $SWA --query "properties.apiKey" -o tsv` |
| `REACT_APP_API_URL` | `https://$APP.azurewebsites.net` |
| `FRONTEND_URL` | `https://$SWA.azurestaticapps.net` |
| `SONAR_TOKEN` | o mesmo do backend |

> ⚠️ **`REACT_APP_API_URL` é crítica.** No Create React App as variáveis são substituídas no código **durante o build**, não lidas em tempo de execução. Sem ela, o site publicado tenta falar com `localhost:3001` e nada funciona. O workflow falha de propósito se o secret estiver ausente, em vez de publicar um site quebrado.

---

## 5. Primeiro deploy

```bash
git push origin main
```

O pipeline então:

1. instala dependências e roda os **223 testes**;
2. **falha o build se a cobertura cair abaixo de 75%**;
3. envia a análise ao SonarCloud;
4. só então constrói a imagem Docker, publica no ACR e faz o deploy;
5. consulta `/health` até a nova versão responder — se não responder em 5 minutos, o deploy é marcado como falho.

As tabelas do banco são criadas sozinhas: `initDB()` roda na subida e usa `CREATE TABLE IF NOT EXISTS`, então é seguro reexecutar a cada deploy.

---

## 6. Verificação pós-deploy

```bash
# API no ar
curl https://$APP.azurewebsites.net/health
# esperado: {"ok":true,"push":true}

# Logs em tempo real
az webapp log tail --resource-group $RG --name $APP

# Confirma que as tabelas foram criadas
az postgres flexible-server execute \
  --name $PG --admin-user $PG_USER --admin-password "$PG_PASS" \
  --database-name ihome \
  --querytext "\dt"
```

Checklist funcional no navegador:

- [ ] criar conta e receber o e-mail de confirmação
- [ ] fazer login e permanecer logado após recarregar a página
- [ ] cadastrar as credenciais Tuya e descobrir dispositivos
- [ ] ligar e desligar um dispositivo
- [ ] convidar outro e-mail e aceitar pelo link
- [ ] conferir se a ação do convidado aparece na tela de Auditoria
- [ ] instalar o PWA pelo navegador do celular

---

## 7. Custo mensal estimado

| Recurso | SKU | Aproximado |
|---|---|---|
| App Service | B1 Linux | US$ 13 |
| PostgreSQL Flexible | B1ms Burstable, 32 GB | US$ 15 |
| Container Registry | Basic | US$ 5 |
| Static Web Apps | Free | US$ 0 |
| **Total** | | **≈ US$ 33/mês** |

Com os US$ 100 do Student Pack, cobre cerca de **três meses** — suficiente para atravessar a entrega de 30/11 e o Demo Day de dezembro.

Para economizar durante o desenvolvimento:

```bash
az webapp stop --resource-group $RG --name $APP           # pausa a API
az postgres flexible-server stop --resource-group $RG --name $PG   # pausa o banco
```

O App Service continua sendo cobrado mesmo parado (você paga pelo plano reservado); o PostgreSQL Burstable, não. Parar o banco fora dos períodos de trabalho é o que mais economiza.

---

## 8. Rollback

Cada imagem é publicada com duas tags: o SHA do commit e `latest`. Para voltar a uma versão anterior:

```bash
# Lista as imagens disponíveis, da mais recente para a mais antiga
az acr repository show-tags --name $ACR --repository ihome-backend --orderby time_desc --output table

# Aponta o App Service para o SHA desejado
az webapp config container set \
  --resource-group $RG --name $APP \
  --container-image-name $ACR.azurecr.io/ihome-backend:<SHA_ANTERIOR>

az webapp restart --resource-group $RG --name $APP
```

É exatamente por isso que a tag com o SHA existe: `latest` sozinho não permitiria escolher uma versão específica.

---

## 9. Rodando localmente

```bash
# Backend
cd ihome-backend
cp .env.example .env       # preencha DATABASE_URL e JWT_SECRET
npm install
npm run dev                # http://localhost:3001

# Frontend, em outro terminal
cd ihome-frontend
cp .env.example .env.local # REACT_APP_API_URL=http://localhost:3001
npm install
npm start                  # http://localhost:3000
```

Com Docker, para reproduzir o ambiente de produção:

```bash
cd ihome-backend
docker build -t ihome-backend .
docker run --rm -p 3001:3001 --env-file .env ihome-backend
```

O `docker build` roda os testes durante a construção — se algum falhar, a imagem não é gerada.
