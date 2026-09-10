# ═══════════════════════════════════════════════════════════════════
#  iHome API — imagem de produção
#
#  Build em dois estágios (multi-stage). O primeiro instala TODAS as
#  dependências e roda os testes; o segundo copia só o necessário para
#  executar. Resultado: a imagem publicada não carrega jest, supertest
#  nem código de teste — menos peso e menos superfície de ataque.
# ═══════════════════════════════════════════════════════════════════

# ── ESTÁGIO 1: build e verificação ──────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

# Copiamos apenas os manifests antes do código-fonte de propósito.
# O Docker guarda em cache cada camada: enquanto package.json não mudar,
# o npm ci não roda de novo, mesmo que todo o código tenha mudado.
COPY package*.json ./

# npm ci (e não npm install) instala exatamente o que está no lock file.
# É o que garante que a imagem de hoje tenha as mesmas versões da de ontem.
RUN npm ci

COPY . .

# Os testes rodam DENTRO do build: se falharem, a imagem não é gerada e
# nada quebrado chega a ser publicado.
RUN npm test


# ── ESTÁGIO 2: runtime ──────────────────────────────────────────────
FROM node:24-alpine AS runtime

# Sinaliza ao Node (e às bibliotecas) que é produção: desativa stack
# traces detalhadas e ativa caminhos otimizados do Express.
ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

# Só as dependências de produção. --omit=dev deixa jest e supertest de fora.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código da aplicação, já verificado no estágio anterior.
COPY --from=build /app/index.js ./index.js
COPY --from=build /app/src ./src

# ── Usuário sem privilégios ──
# A imagem do Node já traz o usuário 'node'. Rodar como root dentro do
# container significa que uma falha na aplicação vira root no container —
# trocar de usuário limita o estrago.
USER node

EXPOSE 3001

# O orquestrador usa isto para saber se a instância está saudável e
# reiniciá-la quando não estiver. Aponta para a rota /health, que responde
# sem exigir autenticação nem banco.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Sem npm start: o npm vira um processo intermediário que não repassa
# SIGTERM direito, e o container demora a encerrar. Chamando o node
# direto, ele é o PID 1 e recebe os sinais do orquestrador.
CMD ["node", "index.js"]
