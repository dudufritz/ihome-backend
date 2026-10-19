/**
 * helpers/ambiente-rotas.js — Ambiente compartilhado dos testes de rota.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * Os testes de integração das rotas viviam num único `routes.test.js` de 741
 * linhas com 29 blocos `describe`. O @pdrollucas apontou isso no review do
 * PR #1: o arquivo já estava dividido por domínio internamente, e transferir
 * cada parte para o próprio arquivo facilitaria a manutenção.
 *
 * O obstáculo era o cabeçalho: 60 linhas de variáveis de ambiente, mocks e
 * `beforeEach` que todos os blocos compartilham. Copiá-lo em cada arquivo
 * novo trocaria um problema por outro — sete cópias de uma configuração que
 * precisa mudar junto.
 *
 * Aqui ele fica uma vez só. Cada arquivo de rota faz um `require` deste
 * módulo na primeira linha e recebe o ambiente pronto.
 *
 * SOBRE A ORDEM DAS CHAMADAS
 *
 * `jest.mock()` normalmente é içado para o topo do arquivo de teste pelo
 * Babel. Aqui as chamadas acontecem em tempo de execução, quando este módulo
 * é carregado — e funcionam porque quem carrega o faz na primeira linha,
 * antes de qualquer `require` do código de produção. O `app` real só é
 * montado dentro do `beforeAll`, bem depois.
 */

// ── Variáveis de ambiente ──
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
// O assistente exige a chave configurada; sem ela a rota responde 503 antes
// de chamar o modelo. Como estes testes exercitam justamente o caminho do
// Gemini (com axios mockado), a chave precisa existir no ambiente de teste.
process.env.GEMINI_API_KEY = 'test-gemini-key';
// Modelo fixado: com GEMINI_MODEL definido, o serviço não vai à rede perguntar
// quais modelos existem. Estes testes exercitam as AÇÕES do assistente, não a
// descoberta — que tem suíte própria em ai-modelo.test.js.
process.env.GEMINI_MODEL = 'gemini-2.5-flash';

// ── Mocks das dependências externas ──
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => {
  // O mock precisa expor a mesma interface do Pool real: além de query(),
  // o código de produção registra um listener de erro com pool.on('error').
  const Pool = jest.fn().mockImplementation(() => ({
    query: mockQuery,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const jwt = require('jsonwebtoken');
const axios = require('axios');

// Preenchido no beforeAll, quando o app real é carregado.
const ctx = { app: null, tokenCache: null };

/**
 * Registra os ganchos de ciclo de vida.
 *
 * Chamado uma vez por arquivo de teste. O `app` é exposto por uma função
 * (`ctx.app` só existe depois do beforeAll) em vez de por valor — senão cada
 * arquivo capturaria `null` no momento do require.
 */
function prepararAmbiente() {
  beforeAll(() => {
    const mod = require('../../index');
    ctx.app = mod.app;
    ctx.tokenCache = mod.tokenCache;
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    axios.mockReset();
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Limpa o cache de tokens Tuya para evitar reuso entre testes: um token
    // guardado de um teste anterior faria o seguinte pular a chamada de
    // autenticação que ele pretende exercitar.
    if (ctx.tokenCache) Object.keys(ctx.tokenCache).forEach((k) => delete ctx.tokenCache[k]);
    // Restaura o mock padrão do axios.
    axios.get = jest.fn();
    axios.post = jest.fn();
  });

  afterAll(() => { jest.clearAllMocks(); });
}

/** Token JWT válido para as rotas autenticadas. */
function tok(email = 'test@ihome.com', sub = 'u1') {
  return jwt.sign({ email, sub }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

/**
 * Simula a conversa completa com a Tuya: credenciais no banco, token via
 * axios.get e a resposta de status de cada dispositivo.
 *
 * Fica aqui porque três arquivos diferentes precisam dela — dispositivos,
 * assistente e descoberta.
 */
function mockTuya(devicesResult = [], statusResult = []) {
  // getUserTuya -> pool.query
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
    rowCount: 1,
  });
  // getToken via axios.get
  axios.get.mockResolvedValueOnce({
    data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
  });
  // Dispositivos do usuário via pool.query
  mockQuery.mockResolvedValueOnce({ rows: devicesResult, rowCount: devicesResult.length });
  // tuyaRequest para cada dispositivo via axios()
  statusResult.forEach((s) => {
    axios.mockResolvedValueOnce({ data: { result: s } });
  });
}

module.exports = { ctx, prepararAmbiente, tok, mockTuya, mockQuery, axios };
