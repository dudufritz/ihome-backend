# iHome — API

API REST do iHome, sistema de automação residencial que conecta o usuário aos seus dispositivos Tuya IoT através de um Progressive Web App, com assistente em linguagem natural, compartilhamento de casa entre pessoas e registro de auditoria.

**Autor:** Eduardo Fritz · eduardosolifritz@gmail.com
**Instituição:** Centro Universitário Católica de Santa Catarina — Engenharia de Software
**Disciplina:** Portfólio · 2026/2

| | |
|---|---|
| **Frontend** | [ihome-frontend](https://github.com/dudufritz/ihome-frontend) |
| **Documentação** | [Wiki](../../wiki) · [Arquitetura](ARQUITETURA.md) · [Deploy](infra/AWS.md) |
| **Stack** | Node.js 24 · Express 5 · PostgreSQL 16 · Docker · Caddy · AWS EC2 |

---

## O problema

Automação residencial doméstica esbarra em três obstáculos. Os aplicativos dos fabricantes são fragmentados — cada marca exige o seu. As interfaces exigem que o usuário traduza a própria intenção em cliques por menus. E compartilhar o controle da casa com a família costuma significar entregar a senha da conta, sem qualquer registro de quem fez o quê.

## A solução

Um PWA único que unifica dispositivos Tuya de qualquer fabricante, entende comandos em português através do Google Gemini, permite convidar pessoas com permissão de apenas visualizar ou de controlar, e registra cada ação com autor, horário e resultado.

---

## Como rodar

```bash
git clone https://github.com/dudufritz/ihome-backend.git
cd ihome-backend
npm install

cp .env.example .env      # preencha DATABASE_URL e JWT_SECRET
npm run gen:key           # gera uma chave de 32 bytes para JWT_SECRET e ENCRYPTION_KEY

npm run dev               # http://localhost:3001
```

As tabelas são criadas sozinhas na primeira execução — `initDB()` usa `CREATE TABLE IF NOT EXISTS`, então rodar de novo é seguro.

### Com Docker Compose (recomendado)

Sobe banco e API juntos, sem precisar instalar PostgreSQL na máquina:

```bash
docker compose up
```

Em outro terminal, o frontend:

```bash
cd ../ihome-frontend
npm install
echo "REACT_APP_API_URL=http://localhost:3001" > .env.local
npm start                 # abre em http://localhost:3000
```

O frontend fica fora do compose de propósito: o servidor de desenvolvimento do Create React App é mais rápido nativo e mantém o hot reload.

### Só a imagem de produção

```bash
docker build -t ihome-backend .
docker run --rm -p 3001:3001 --env-file .env ihome-backend
```

O `docker build` executa a suíte de testes durante a construção: se algum falhar, a imagem não é gerada.

### Testes

```bash
npm test                  # 224 testes, cobertura ~93%
```

---

## Arquitetura

Organização em camadas, com regra de dependência `routes → services → config/db`. Um serviço nunca importa uma rota, o que mantém o grafo acíclico e permite testar qualquer serviço sem levantar o Express.

```
index.js                 Ponto de entrada: liga as peças e sobe o servidor
src/
├── app.js               Monta o Express (sem abrir porta) — é o que os testes importam
├── config/              Variáveis de ambiente e pool do PostgreSQL
├── db/                  Criação e evolução do esquema
├── middleware/          Verificação do JWT — a fronteira de confiança
├── services/            Regras de negócio: auth, tuya, sharing, audit, ai, mail, push, crypto
├── routes/              Endpoints HTTP, um arquivo por área
├── jobs/                Rotinas em segundo plano: monitor, agendador, retenção
└── utils/               Auxiliares de e-mail e HTTP
```

O detalhamento de cada decisão está em [ARQUITETURA.md](ARQUITETURA.md).

---

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/auth/register` | Cria conta |
| `POST` | `/auth/login` | Autentica e devolve access + refresh token |
| `POST` | `/auth/refresh` | Rotaciona o refresh token |
| `POST` | `/auth/logout` | Revoga a sessão do dispositivo |
| `POST` | `/auth/forgot-password` | Envia link de redefinição |
| `POST` | `/auth/reset-password` | Define a nova senha |
| `GET` | `/auth/verify-email/:token` | Confirma o endereço de e-mail |
| `GET` | `/auth/me` | Dados do usuário autenticado |
| `GET/POST` | `/tuya-credentials` | Credenciais da conta Tuya (segredo cifrado) |
| `GET/POST/DELETE` | `/my-devices` | Cadastro de dispositivos |
| `GET` | `/discover-devices` | Lista o que existe na conta Tuya |
| `GET` | `/devices` | Dispositivos com estado em tempo real |
| `POST` | `/devices/:id/command` | Liga ou desliga |
| `GET` | `/devices/:id/status` | Estado de um dispositivo |
| `GET/POST/DELETE` | `/shares` | Convites de compartilhamento |
| `GET/DELETE` | `/shared-with-me` | Casas às quais tenho acesso |
| `GET/PUT/DELETE` | `/alerts` | Alertas de conectividade |
| `GET/DELETE` | `/schedules` | Rotinas agendadas |
| `POST` | `/ai-command` | Comando em linguagem natural |
| `GET` | `/audit-log` | Registro de auditoria, com filtros |
| `GET` | `/audit-log/actors` | Usuários que aparecem no log |
| `POST/DELETE` | `/push-subscribe` | Assinaturas de notificação |
| `GET` | `/health` | Verificação de saúde |

Todas as rotas exigem `Authorization: Bearer <token>`, exceto `/`, `/health`, `/vapid-public-key`, as de `/auth` (menos `/auth/me`) e os links de aceite de convite.

---

## Decisões técnicas

**Autenticação própria, sem provedor externo.** O iHome emite e valida os próprios tokens: senha com bcrypt, access token JWT de 15 minutos e refresh token opaco de 30 dias, rotacionado a cada uso e com detecção de reuso. HS256 e não RS256 porque quem emite e quem verifica é o mesmo serviço — RS256 traria distribuição de chave pública sem benefício algum aqui.

**Isolamento multi-inquilino pelo e-mail.** Toda consulta filtra por `user_email`, extraído do token. As rotas que recebem um id na URL usam `AND user_email = $2`, o que torna IDOR impossível por construção: o id de outro usuário simplesmente não casa.

**Segredo Tuya cifrado com AES-256-GCM.** O `tuya_secret` é a senha da conta Tuya do usuário. GCM porque é autenticado — um byte adulterado no banco faz a decifragem falhar em vez de devolver lixo. Valores antigos sem o prefixo `enc:v1:` passam intactos, o que permitiu a migração sem downtime.

**Auditoria separa casa de ator.** A tabela guarda `home_owner_email` (onde a ação ocorreu) e `actor_email` (quem a executou). É essa separação que permite ao dono ver o que um convidado fez na casa dele. Tentativas negadas também são registradas — são justamente o evento mais relevante.

**A IA interpreta, o backend decide.** O Gemini devolve a intenção em JSON; o identificador do dispositivo é conferido contra a lista real do usuário antes de virar comando. É a barreira contra alucinação do modelo e contra prompt injection embutida no nome de um dispositivo.

---

## Qualidade

| | |
|---|---|
| Testes | 224, com Jest e Supertest |
| Cobertura | ~93% de statements (mínimo exigido: 75%) |
| Análise estática | SonarCloud, executado a cada push |
| Observabilidade | New Relic APM |
| CI/CD | GitHub Actions — testes, portão de cobertura, build da imagem, deploy e verificação de saúde |

O pipeline falha se a cobertura cair abaixo de 75%, e o job de deploy só executa quando o de testes passa.

---

## Licença

Projeto acadêmico desenvolvido para a disciplina de Portfólio do Centro Universitário Católica de Santa Catarina.
