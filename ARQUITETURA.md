# Arquitetura do backend iHome

Documento de referência da API. Descreve **como o código está organizado**, **por que** cada decisão foi tomada e **onde** encontrar cada responsabilidade.

---

## 1. Visão geral

O iHome é um sistema de automação residencial que conecta o usuário aos seus dispositivos Tuya IoT através de um PWA. O backend é uma API REST em Node.js/Express que cumpre quatro papéis:

1. **Intermediar a Tuya** — assina as requisições com HMAC-SHA256 e guarda as credenciais de cada usuário;
2. **Isolar inquilinos** — garantir que um usuário nunca alcance dados de outro;
3. **Coordenar o compartilhamento** — convites, permissões e revogação de acesso;
4. **Executar rotinas** — monitoramento, agendamentos e retenção, em segundo plano.

O backend **não possui uma conta Tuya central**. Cada usuário cadastra as próprias credenciais. Isso é deliberado: evita que o serviço se torne um ponto único cujo comprometimento entregaria todas as casas de uma vez.

### Hospedagem

```
   navegador  ──►  Azure Static Web Apps  ──►  Azure App Service  ──►  Azure PostgreSQL
                   React 18 · PWA · CDN        Node 24 · container      Flexible Server
```

Integrações externas: Tuya IoT, Google Gemini, Gmail SMTP e Web Push.

O backend roda como **container Docker** no App Service. A imagem é construída pelo pipeline, publicada no Azure Container Registry e identificada pelo SHA do commit — o que torna o rollback uma troca de tag, e não um novo build.

---

## 2. Estrutura de pastas

```
index.js                    Ponto de entrada: liga as peças e sobe o servidor
src/
├── app.js                  Monta o Express (sem abrir porta) — é o que os testes importam
├── config/
│   ├── env.js              Leitura única das variáveis de ambiente
│   └── database.js         Pool de conexões PostgreSQL
├── db/
│   └── schema.js           initDB(): cria tabelas e índices (idempotente)
├── middleware/
│   └── auth.js             Verificação do JWT — a fronteira de confiança
├── services/               Regras de negócio e integrações
│   ├── auth.service.js     Senhas, tokens e sessões
│   ├── crypto.service.js   AES-256-GCM para o segredo Tuya
│   ├── tuya.service.js     Assinatura HMAC, cache de token, chamadas à Tuya
│   ├── sharing.service.js  Autorização de casas compartilhadas
│   ├── audit.service.js    Registro de auditoria e expurgo
│   ├── ai.service.js       Interpretação de linguagem natural (Gemini)
│   ├── mail.service.js     E-mail de convite
│   └── push.service.js     Notificações Web Push (VAPID)
├── routes/                 Endpoints HTTP, um arquivo por área
│   ├── index.js            Registro central dos routers
│   ├── auth.routes.js           /auth/login  /auth/register  /auth/refresh ...
│   ├── health.routes.js         /  /health  /vapid-public-key
│   ├── credentials.routes.js    /tuya-credentials
│   ├── myDevices.routes.js      /my-devices  /discover-devices
│   ├── devices.routes.js        /devices  /devices/:id/command  /devices/:id/status
│   ├── shares.routes.js         /shares  /shared-with-me
│   ├── alerts.routes.js         /alerts
│   ├── push.routes.js           /push-subscribe
│   ├── schedules.routes.js      /schedules
│   ├── audit.routes.js          /audit-log  /audit-log/actors
│   └── ai.routes.js             /ai-command
├── jobs/                   Rotinas em segundo plano
│   ├── index.js            startBackgroundJobs()
│   ├── monitor.job.js      Conectividade dos dispositivos (5 min)
│   └── scheduler.job.js    Rotinas agendadas (1 min)
└── utils/
    ├── email.js            Normalização e validação de e-mail
    └── http.js             asyncHandler, clientIp, httpError
```

**Regra de dependência:** `routes → services → config/db`. Uma rota nunca é importada por um serviço. Isso mantém o grafo acíclico e permite testar qualquer serviço sem levantar o Express.

**Por que `app.js` e `index.js` são separados:** `app.js` apenas constrói a aplicação; `index.js` abre a porta e liga os temporizadores. Os testes importam o app e disparam requisições em memória com `supertest` — sem servidor, sem porta, sem banco.

---

## 3. Autenticação e isolamento multi-inquilino

O iHome **emite e valida os próprios tokens** — não há provedor de identidade externo.

### Fluxo

```
POST /auth/login  →  bcrypt confere a senha
                  →  access token  (JWT HS256, 15 min)
                  →  refresh token (opaco, 30 dias, gravado como hash)

requisição normal →  Authorization: Bearer <access token>
                  →  authMiddleware verifica a assinatura
                  →  req.user = { id, email }

access expirou    →  401 com code: 'token_expired'
                  →  POST /auth/refresh rotaciona o par
                  →  a requisição original é refeita
```

### Por que dois tokens

Um JWT é validado só pela assinatura, sem consultar o banco — rápido, porém **impossível de revogar** antes de expirar. Por isso ele dura 15 minutos. O refresh token vive no banco e pode ser revogado na hora; dura 30 dias e serve apenas para obter novos access tokens.

**Rotação com detecção de reuso:** a cada renovação o token antigo é queimado. Se um token já queimado reaparece, ou é repetição inofensiva de requisição ou é roubo — não há como distinguir, então revogamos todas as sessões do usuário.

### Por que HS256

RS256 resolve **distribuição de chave**: serviços diferentes validando tokens que não emitiram. Aqui quem emite e quem verifica é o mesmo processo, então RS256 traria JWKS, rotação e cache sem contrapartida. Se um segundo serviço passar a validar os tokens, HS256 deixa de servir.

### Isolamento multi-inquilino

Validado o token, o middleware coloca em `req.user.email` o e-mail **normalizado** (minúsculo, sem espaços). Daí em diante, **toda** consulta filtra por esse e-mail:

```sql
SELECT * FROM user_devices WHERE user_email = $1
DELETE FROM user_devices WHERE id = $1 AND user_email = $2
```

O `AND user_email = $2` nas rotas que recebem um id na URL é o que impede **IDOR**: mesmo que alguém descubra o id numérico de outro usuário, a linha não casa e nada é apagado. Não depende de uma verificação que alguém possa esquecer de escrever.

### Proteção contra enumeração de contas

Login e recuperação de senha respondem a mesma coisa exista ou não a conta, e o bcrypt roda **mesmo quando o usuário não existe** (comparando contra um hash fictício). Sem isso, a diferença de tempo — ~1ms contra ~250ms — revelaria quais e-mails têm cadastro.

---

## 4. Integração com a Tuya

A Tuya não aceita uma API key simples. Cada requisição carrega uma assinatura HMAC-SHA256 que cobre método, corpo, caminho e horário — provando conhecimento do secret sem transmiti-lo.

```
sign = HMAC-SHA256(secret, accessId + token + timestamp + método + SHA256(corpo) + caminho)
```

Dois detalhes que costumam quebrar a integração:

- **Parâmetros de query em ordem alfabética.** Fora de ordem, a assinatura calculada aqui não bate com a calculada lá e a chamada é rejeitada.
- **Cache de token.** Cada token vale ~2 horas. Sem cache, gastaríamos uma autenticação antes de cada operação. Guardamos com 60s de margem para nunca usar um token que vence no meio do caminho.

---

## 5. Segurança dos segredos

O `tuya_secret` é a senha da conta Tuya: quem o obtém controla a casa. Ele é cifrado com **AES-256-GCM** antes de tocar o banco.

```
enc:v1:<iv>:<authTag>:<textoCifrado>
```

- **GCM** é um modo *autenticado*: além de cifrar, gera uma tag que prova que o dado não foi adulterado. Um byte trocado no banco faz a decifragem falhar em vez de devolver lixo.
- **IV aleatório a cada gravação**: o mesmo segredo cifrado duas vezes produz resultados diferentes, então ninguém descobre que dois usuários usam a mesma credencial.
- **Compatibilidade**: valores sem o prefixo `enc:v1:` são reconhecidos como linhas antigas em texto puro e devolvidos intactos. A migração acontece naturalmente, sem downtime, conforme cada usuário atualiza suas credenciais.

> ⚠️ Sem `ENCRYPTION_KEY` configurada, o sistema opera em **modo degradado**: grava em texto puro e avisa no log. Rodar sem a chave é uma escolha, não um acidente silencioso.

**Único ponto de decifragem:** `getUserTuya()`. Concentrar isso num lugar garante que nenhuma rota manipule o valor cifrado por engano.

---

## 6. Compartilhamento de casa

```
POST /shares  →  status 'pending' + token de 32 bytes  →  e-mail
                                                            ↓
                                            clique em "aceitar"
                                                            ↓
                                                  status 'accepted'
```

Dois níveis de permissão: `view` (só enxerga) e `control` (também liga/desliga).

A autorização vive inteira em `sharing.service.js`, na função `resolveHomeAccess()`. Concentrá-la ali foi o que permitiu corrigir — e impedir a reincidência de — a falha descrita a seguir.

### Falha corrigida: convite pendente concedia controle

A versão anterior consultava a tabela assim:

```sql
SELECT permission FROM home_shares
WHERE owner_email = $1 AND guest_email = $2
```

Faltava `AND status = 'accepted'`. Consequência: **bastava ter sido convidado — mesmo sem nunca aceitar — para já controlar a casa.** A rota `/my-devices` filtrava o status corretamente, mas `/devices/:id/command` não; a regra estava duplicada em dois lugares e divergiu.

A correção foi mover a regra para um único ponto e cobri-la com teste (`security.test.js`).

---

## 7. Registro de auditoria

Responde a três perguntas sobre cada ação sensível: **quem**, **o quê**, **quando**.

A tabela separa dois e-mails de propósito:

| coluna | significado |
|---|---|
| `home_owner_email` | a **casa** onde a ação ocorreu |
| `actor_email` | **quem** executou a ação |

É essa separação que permite ao dono ver o que um convidado fez na casa dele. A cláusula de visibilidade é sempre a primeira condição do `WHERE`:

```sql
(home_owner_email = $1 OR actor_email = $1)
```

Os filtros vindos da query string só podem **restringir** o conjunto, nunca ampliá-lo. Não existe parâmetro capaz de fazer alguém enxergar a casa de um terceiro.

**Duas decisões de projeto:**

- `recordAudit()` **nunca lança exceção.** Auditoria é efeito colateral da ação, não a ação. Se o banco falhar ao gravar o log, o usuário não pode receber erro por uma luz que de fato acendeu.
- **Tentativas negadas também são registradas.** Um 403 é justamente o evento que o dono da casa mais precisa conseguir enxergar.

Registros acima de 90 dias são expurgados diariamente — cada clique num interruptor é uma linha, e sem isso a tabela viraria o maior objeto do banco.

---

## 8. Assistente de IA

Usa **Google Gemini 1.5 Flash**. O modelo apenas **interpreta**; quem executa é o backend.

```
"apaga a luz da sala"  →  Gemini  →  {"action":"control","deviceId":"...","state":false}
                                            ↓
                            validação: esse ID existe na casa do usuário?
                                            ↓
                                    comando assinado à Tuya
                                            ↓
                                        auditoria
```

A validação do `deviceId` contra a lista real de dispositivos é a barreira contra dois riscos: **alucinação** (o modelo inventa um identificador) e **prompt injection** (um dispositivo batizado de "ignore as instruções acima"). O modelo sugere; o backend decide.

Ações disparadas pelo assistente também vão para a auditoria — senão o assistente seria um caminho para agir sem deixar rastro.

---

## 9. Rotinas em segundo plano

| rotina | intervalo | o que faz |
|---|---|---|
| `monitorDevices` | 5 min | consulta a Tuya e detecta transições online/offline |
| `runSchedules` | 1 min | executa rotinas agendadas para o minuto corrente |
| `purgeAuditLog` | 24 h | remove registros de auditoria acima da retenção |

**O ponto central do monitor:** ele alerta sobre **transição**, não sobre estado. A tabela `device_status_cache` guarda o último estado conhecido; só há alerta quando o estado atual difere dele. Sem isso, um dispositivo desligado da tomada geraria um alerta a cada 5 minutos, para sempre.

Os jobs **não são iniciados em ambiente de teste** — temporizadores pendentes deixam o Jest sem encerrar e poluem as asserções sobre chamadas ao banco.

---

## 10. Proteção da API

Três defesas independentes, aplicadas nesta ordem em `src/app.js`:

| Camada | O que faz | O que **não** faz |
|---|---|---|
| `helmet` | Cabeçalhos que instruem o navegador: `nosniff`, HSTS, anti-clickjacking, remove `X-Powered-By` | Não protege contra cliente que ignore cabeçalhos |
| CORS restrito | Só o frontend conhecido pode chamar a API **pelo navegador** | Não impede `curl` — CORS é proteção do navegador |
| Rate limiting | Teto de requisições, por rota sensível | Não distingue requisição legítima de maliciosa |

Nenhuma substitui as outras: um atacante com `curl` ignora as duas primeiras, e só a terceira o alcança.

### Limites aplicados

| Rota | Teto na janela de 15 min | Motivo |
|---|---|---|
| Global | 300 por IP | Rede de proteção contra abuso amplo |
| `/auth/login`, `/register`, `/forgot-password`, `/reset-password` | 10 | Força bruta de senha |
| `/ai-command` | 30 | Cada chamada consome cota paga do Gemini |

Nas rotas de credencial vale `skipSuccessfulRequests`: **só as tentativas que falham contam**. Quem acerta a senha e navega normalmente nunca esbarra no teto; quem erra seguidamente é barrado rápido.

A contagem usa o e-mail do usuário quando há um autenticado, e o IP quando não há. Contar só por IP bloquearia uma faculdade inteira por causa de um usuário intenso.

### `trust proxy` é 1, não `true`

O App Service coloca o IP real do cliente em `X-Forwarded-For`. Confiar na cadeia inteira (`true`) permitiria a qualquer cliente forjar o próprio IP inserindo um cabeçalho falso — e assim escapar do rate limiting. Com `1`, confiamos apenas no salto mais próximo, que é o nosso.

---

## 11. Testes

```bash
npm test     # 223 testes, cobertura ~93%
```

| arquivo | assunto |
|---|---|
| `routes.test.js` | integração das rotas com o app real |
| `audit.test.js` | gravação, visibilidade e filtros da auditoria |
| `security.test.js` | criptografia, normalização de e-mail, autorização |
| `auth-flow.test.js` | cadastro, login, rotação de token, reset de senha |
| `jobs.test.js` | monitor, agendador e esquema do banco |
| `security-extra.test.js` | helmet, CORS, rate limiting, expiração de convite |
| `auth.test.js` / `api.test.js` / `health.test.js` | autenticação e rotas públicas |

O banco, o `axios`, o `web-push` e o `nodemailer` são mockados. Nenhum teste depende de rede ou de PostgreSQL rodando, o que os torna determinísticos e viáveis no pipeline do GitHub Actions.

---

## 12. Limitações conhecidas

Registradas aqui de forma explícita, porque conhecer os limites do próprio sistema vale mais do que fingir que não existem.

- **Fuso horário dos agendamentos** — usa o relógio do servidor. Com o app implantado em região brasileira coincide com o do usuário; a evolução natural é guardar o fuso de cada um.
- **`rejectUnauthorized: false`** no SSL do banco — aceita o certificado do Azure sem validar a cadeia. Protege contra escuta passiva, não contra um intermediário ativo.
- **Escopo da auditoria** — hoje cobre comandos em dispositivos. Compartilhamento, credenciais e agendamentos ainda não são registrados; a infraestrutura (`recordAudit`) já aceita qualquer `action`.
- **Rate limiting em memória** — o contador vive no processo. Com mais de uma instância do App Service, cada uma teria o próprio contador e o teto efetivo seria multiplicado. Resolver exige um store compartilhado (Redis).

### Resolvido nesta versão

| Antes | Agora |
|---|---|
| `cors()` aceitava qualquer origem | Allowlist com `FRONTEND_URL` + `CORS_EXTRA_ORIGINS` |
| Sem cabeçalhos de segurança | `helmet` com HSTS, `nosniff` e anti-clickjacking |
| `/ai-command` sem limite | 30 chamadas por usuário a cada 15 min |
| Login sem proteção contra força bruta | 10 tentativas falhas por janela |
| Convite válido para sempre | Expira em 7 dias, configurável |
