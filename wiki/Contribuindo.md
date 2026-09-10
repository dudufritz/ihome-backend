# Contribuindo

## Rodando localmente

```bash
# Backend
git clone https://github.com/dudufritz/ihome-backend.git
cd ihome-backend
npm install
cp .env.example .env       # preencha DATABASE_URL e JWT_SECRET
npm run gen:key            # gera chaves de 32 bytes
npm run dev                # http://localhost:3001

# Frontend, em outro terminal
git clone https://github.com/dudufritz/ihome-frontend.git
cd ihome-frontend
npm install
cp .env.example .env.local # REACT_APP_API_URL=http://localhost:3001
npm start                  # http://localhost:3000
```

Você precisará de um banco PostgreSQL. Para desenvolvimento:

```bash
docker run -d --name ihome-pg \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=ihome \
  -p 5432:5432 postgres:16
```

E então `DATABASE_URL=postgresql://postgres:devpass@localhost:5432/ihome`.

As tabelas são criadas sozinhas na primeira execução.

---

## Padrões de código

### Comentários explicam o porquê, não o quê

O código já diz o que faz. O comentário existe para registrar a razão da escolha e o que foi descartado.

```js
// ❌ Não acrescenta nada
// Busca o usuário pelo e-mail
const user = await buscarPorEmail(email);

// ✅ Registra uma decisão
// Comparamos a senha mesmo quando o usuário não existe: sem isso, um login
// com e-mail inexistente responderia em 1ms e um existente em 250ms, e essa
// diferença permitiria descobrir quais e-mails têm conta.
const senhaConfere = await verifyPassword(password, user?.password_hash);
```

### Regra de dependência

`routes → services → config/db`. Um serviço **nunca** importa uma rota. Regra de negócio vive em `services/`, não em `routes/` — foi a duplicação de uma regra entre duas rotas que produziu a falha de autorização corrigida na v1.1.

### Consultas ao banco

Sempre parametrizadas. Nunca concatenação de string, mesmo com filtros dinâmicos:

```js
// ❌ Injeção de SQL
where += ` AND actor_email = '${actor}'`;

// ✅ Parâmetro numerado
params.push(actor);
where += ` AND actor_email = $${params.length}`;
```

### Isolamento multi-inquilino

Toda consulta filtra por `user_email`. Rotas que recebem um id na URL usam `AND user_email = $2`:

```js
'DELETE FROM user_devices WHERE id = $1 AND user_email = $2'
```

Sem isso, o id de outro usuário funcionaria.

---

## Testes

```bash
cd ihome-backend  && npm test    # 201 testes, mínimo 75%
cd ihome-frontend && npm test    # 49 testes, mínimo 25%
```

O pipeline falha se a cobertura cair abaixo do mínimo, então rode antes de abrir o pull request.

**O que testar:** o comportamento observável, não a implementação. Um teste que afirma "a consulta contém `status = 'accepted'`" protege a regra de segurança; um que afirma "a função foi chamada 3 vezes" quebra na primeira refatoração sem apontar defeito algum.

**Mocks:** banco, `axios`, `web-push` e `nodemailer` são mockados. Nenhum teste depende de rede ou de PostgreSQL rodando — é o que os torna determinísticos no pipeline.

---

## Fluxo de contribuição

1. Abra uma issue descrevendo o problema ou a proposta.
2. Crie a branch a partir da `main`: `feat/nome-curto` ou `fix/nome-curto`.
3. Faça commits pequenos, com mensagem no imperativo: `feat: registrar tentativas negadas na auditoria`.
4. Garanta que `npm test` passa nos dois repositórios afetados.
5. Abra o pull request descrevendo **o que mudou e por quê**.
6. O pipeline roda testes, portão de cobertura e SonarCloud. Todos precisam passar.

### Prefixos de commit

| Prefixo | Uso |
|---|---|
| `feat:` | Funcionalidade nova |
| `fix:` | Correção de defeito |
| `refactor:` | Mudança interna sem alterar comportamento |
| `test:` | Testes |
| `docs:` | Documentação |
| `chore:` | Configuração, dependências, pipeline |

---

## Segurança

Encontrou uma falha? **Não abra issue pública.** Escreva para eduardosolifritz@gmail.com com a descrição e, se possível, os passos para reproduzir.

Nunca commite `.env`, chaves ou credenciais. Se acontecer, além de remover o arquivo, **gere novos segredos** — o histórico do Git guarda o valor antigo para sempre.
