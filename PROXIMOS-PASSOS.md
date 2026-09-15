# O que falta para o app funcionar

Cinco passos. **A ordem importa** — o passo 4 só faz sentido depois do 2, e o 5
só depois do 4.

> O que já está pronto: a API está no ar com o código novo, o frontend compila
> com a URL correta embutida, e os dois pipelines estão verdes. O que falta é
> configuração, e boa parte só você pode fazer: são segredos.

**Seus recursos no Azure** (conferidos em 14/09):

| Recurso | Tipo | Região |
|---|---|---|
| `ihome-app` | App Service — a API | West Central US |
| `ihome-app-server` | PostgreSQL — o banco | West Central US |
| `ihome-front` | Static Web App — o site | East US 2 |
| `ASP-Ihome-9c05` | Plano que cobra pelo App Service | West Central US |
| `vnet-lzbljxgr` + `privatelink.postgres…` | Rede privada do banco | — |

---

## 1️⃣ Baixar o plano — faça hoje, é dinheiro por hora

O plano está em **P0v4**, da linha Premium: algo entre US$ 60 e 80 por mês. O
**B1** faz o mesmo para este projeto por ~US$ 13. Com Premium, seus créditos
acabam antes do Demo Day.

1. Portal → busque **ihome-app**
2. Menu da esquerda → **Plano do Serviço de Aplicativo**
3. **Escalar verticalmente (Plano do Serviço de Aplicativo)**
4. Aba **Desenvolvimento/Teste** → **B1** → **Selecionar**

Não derruba o site: troca o tamanho da máquina por baixo.

> Se o B1 der erro de cota, escolha **F1 (Gratuito)** por enquanto. O F1 dorme
> depois de 20 minutos parado — não serve para a apresentação, mas segura o
> gasto até resolvermos.

---

## 2️⃣ Gerar os dois segredos

Abra o [Cloud Shell](https://shell.azure.com) (ícone `>_` no topo do portal) e
rode **duas vezes**:

```bash
openssl rand -hex 32
```

Cada execução devolve 64 caracteres. O primeiro será o `JWT_SECRET`, o segundo
o `ENCRYPTION_KEY`.

> ⚠️ **Guarde os dois fora do Azure** — bloco de notas, gerenciador de senhas.
> Trocar o `JWT_SECRET` desconecta todo mundo. Perder o `ENCRYPTION_KEY` torna
> as credenciais Tuya já cifradas **impossíveis de recuperar**.

---

## 3️⃣ Preencher as variáveis no App Service

Portal → **ihome-app** → menu esquerdo → **Configurações** → **Variáveis de
ambiente**. Para cada linha: **+ Adicionar**, preencha Nome e Valor. No fim,
**Aplicar** e confirme.

| Nome | Valor | Sem ela |
|---|---|---|
| `JWT_SECRET` | o primeiro código do passo 2 | nenhum login funciona |
| `ENCRYPTION_KEY` | o segundo código do passo 2 | segredos Tuya ficam em texto puro |
| `DATABASE_URL` | veja abaixo | a API não acessa o banco |
| `FRONTEND_URL` | `https://ihomeauto.com` | o site é bloqueado pelo CORS |
| `BACKEND_URL` | `https://ihome-app-ffa2cgh4ghbecwda.westcentralus-01.azurewebsites.net` | links do e-mail saem errados |
| `NODE_ENV` | `production` | SSL do banco não é ativado |
| `GEMINI_API_KEY` | sua chave do Gemini | assistente desativado |
| `GMAIL_USER` | seu e-mail | convites não são enviados |
| `GMAIL_APP_PASSWORD` | senha de app do Gmail | idem |

### Sobre a `DATABASE_URL`

**Antes de criar, procure na lista se já existe `AZURE_POSTGRESQL_CONNECTIONSTRING`.**
O Azure costuma criar essa variável sozinho quando o App Service é provisionado
junto com o banco — e o código agora lê essa variável automaticamente quando a
`DATABASE_URL` não existe. Se ela já estiver lá **e começar com `postgresql://`**,
não precisa fazer nada neste item.

Se não existir, ou se existir no formato `Server=...;Database=...`, monte a sua:

```
postgresql://USUARIO:SENHA@ihome-app-server.postgres.database.azure.com:5432/ihome?sslmode=require
```

Troque `USUARIO` e `SENHA` pelos que você definiu ao criar o banco. Se não
lembrar o nome do banco, veja em **ihome-app-server** → **Bancos de dados**.

> **Atenção à rede:** o seu PostgreSQL está atrás de um *private endpoint* — ele
> não é acessível pela internet, só de dentro da rede virtual `vnet-lzbljxgr`.
> Isso é bom para segurança e provavelmente já está configurado, porque o Azure
> costuma ligar os dois quando são criados juntos. Se depois de tudo o
> `/health` continuar dizendo que o banco está desconectado, confira em
> **ihome-app** → **Rede** → **Integração de rede virtual** se a VNet aparece
> ligada. É o único ponto deste guia que pode exigir um passo extra.

### Como saber se deu certo

Abra no navegador, depois de o App Service reiniciar (leva ~1 minuto):

```
https://ihome-app-ffa2cgh4ghbecwda.westcentralus-01.azurewebsites.net/health
```

A resposta agora diz o que está configurado:

```json
{
  "ok": true,
  "push": false,
  "config": {
    "database": true,
    "auth": true,
    "frontendUrl": true,
    "ai": true,
    "email": true
  }
}
```

**Todos os campos de `config` precisam estar `true`** (o `push` é opcional).
Qualquer `false` aponta exatamente qual variável faltou.

---

## 4️⃣ Publicar o site no Azure

Hoje o `ihome-front` responde **404**: não há nada em produção, porque o único
envio para a `main` foi justamente o build que falhava.

O conteúdo já está pronto no branch `develop`, nos dois Pull Requests. Assim que
o Pedro e o Luis comentarem (você precisa dos reviews para a N1 de qualquer
forma), faça o merge:

1. Abra o PR do frontend → **Merge pull request**
2. O workflow do Azure roda sozinho e publica

Para conferir, abra o endereço do Static Web App — ele aparece em **ihome-front**
→ **Visão geral** → **URL**. Deve mostrar a tela de login, e agora o botão
**Entrar** deve funcionar de verdade.

---

## 5️⃣ Tirar o domínio da Vercel

O `ihomeauto.com` ainda aponta para a Vercel — o cabeçalho da resposta diz
`server: Vercel`. Desinstalar o app do GitHub parou os deploys novos, mas o
domínio continua servindo o último build que ela fez.

**Só faça este passo depois que o passo 4 estiver funcionando**, senão o site
fica fora do ar no intervalo.

1. No painel da Vercel, remova o domínio `ihomeauto.com` do projeto
2. No Azure: **ihome-front** → **Domínios personalizados** → **Adicionar**
3. O Azure mostra um registro (CNAME ou TXT) para criar no seu registrador
4. Crie o registro onde o domínio está registrado e aguarde a validação

> Você também tem uma zona DNS no Azure chamada `intligenthomeservices.net`
> (repare que falta o "e" de "intelligent"). Se o `ihomeauto.com` for gerenciado
> por lá, o registro pode ser criado direto no portal. Se estiver em outro
> registrador, é lá que você mexe.

---

## Depois de tudo

- [ ] `/health` com todos os `config` em `true`
- [ ] Login funcionando no endereço do Static Web App
- [ ] `ihomeauto.com` respondendo pelo Azure (confira: o cabeçalho não pode mais dizer `server: Vercel`)
- [ ] Publicar a Wiki — instruções em [`wiki/PUBLICAR.md`](wiki/PUBLICAR.md)
- [ ] Marcar as duas orientações — prazo 30/09
