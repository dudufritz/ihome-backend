/**
 * ai-modelo.test.js — Descoberta do modelo do Gemini.
 *
 * O caso real: o projeto estava fixado em `gemini-1.5-flash`. O Google
 * aposentou esse modelo, e uma chave de API criada depois disso não tem
 * acesso a ele — a API responde 404. O assistente parou de funcionar sem que
 * nada no iHome tivesse mudado, e a tela dizia apenas "não consegui processar
 * o comando", que não aponta para lugar nenhum.
 *
 * A correção é não presumir: perguntar ao Google quais modelos a chave
 * alcança e escolher entre os que existem.
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.GEMINI_API_KEY = 'chave-de-teste';
delete process.env.GEMINI_MODEL;   // sem modelo fixo: queremos a descoberta

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

/**
 * Cada teste precisa de um módulo limpo: `descobrirModelo` guarda a escolha
 * em cache, e o cache sobreviveria de um teste para o outro.
 *
 * O `require` do axios vem DEPOIS do resetModules de propósito — senão o
 * teste configuraria um mock e o serviço receberia outro, e nada casaria.
 */
function moduloLimpo() {
  jest.resetModules();
  const axios = require('axios');
  axios.get.mockReset();
  axios.post.mockReset();
  const servico = require('../src/services/ai.service');
  return { axios, ...servico };
}

/** Resposta do endpoint que lista modelos. */
const listaDeModelos = (nomes) => ({
  data: {
    models: nomes.map((n) => ({
      name: `models/${n}`,
      supportedGenerationMethods: ['generateContent'],
    })),
  },
});

describe('Escolha do modelo', () => {
  test('prefere um modelo flash entre os disponíveis', async () => {
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce(
      listaDeModelos(['gemini-2.5-pro', 'gemini-2.5-flash', 'embedding-001'])
    );
    await expect(descobrirModelo()).resolves.toBe('gemini-2.5-flash');
  });

  test('descarta versões de preview e experimentais', async () => {
    // Elas mudam de comportamento sem aviso e somem sem depreciação.
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce(
      listaDeModelos(['gemini-3.0-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash-exp'])
    );
    await expect(descobrirModelo()).resolves.toBe('gemini-2.5-flash');
  });

  test('prefere o flash cheio ao flash-lite', async () => {
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce(
      listaDeModelos(['gemini-2.5-flash-lite', 'gemini-2.5-flash'])
    );
    await expect(descobrirModelo()).resolves.toBe('gemini-2.5-flash');
  });

  test('sem nenhum flash, usa o primeiro que gere conteúdo', async () => {
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-pro']));
    await expect(descobrirModelo()).resolves.toBe('gemini-2.5-pro');
  });

  test('só consulta a lista uma vez', async () => {
    // A lista não muda durante a execução; consultar a cada comando somaria
    // uma ida à rede a algo que o usuário está esperando.
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash']));
    await descobrirModelo();
    await descobrirModelo();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('chave sem nenhum modelo dá erro explícito', async () => {
    const { axios, descobrirModelo } = moduloLimpo();
    axios.get.mockResolvedValueOnce({ data: { models: [] } });
    await expect(descobrirModelo()).rejects.toThrow(/Nenhum modelo/i);
  });

  test('GEMINI_MODEL definido vence a descoberta', async () => {
    // Quem configurou explicitamente quer aquele modelo, não o que acharmos
    // melhor — e nem gasta a chamada para descobrir.
    process.env.GEMINI_MODEL = 'gemini-2.0-flash';
    const { axios, descobrirModelo } = moduloLimpo();
    await expect(descobrirModelo()).resolves.toBe('gemini-2.0-flash');
    expect(axios.get).not.toHaveBeenCalled();
    delete process.env.GEMINI_MODEL;
  });
});

/**
 * Listar não é o mesmo que poder usar.
 *
 * Isto quebrou em produção depois de a descoberta já estar no ar: o Google
 * LISTOU `gemini-2.5-flash` como suportando generateContent e respondeu 404
 * quando o comando foi de fato enviado. A primeira versão tratava a listagem
 * como promessa de acesso; não é. Chave de camada gratuita e restrição por
 * região produzem exatamente essa diferença.
 */
describe('Modelo listado que recusa a chamada', () => {
  const um404 = { response: { status: 404, data: {} } };

  test('passa para o próximo candidato em vez de desistir', async () => {
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash', 'gemini-2.5-flash-lite']));
    ax.post
      .mockRejectedValueOnce(um404)                                    // flash recusa
      .mockResolvedValueOnce({ data: { candidates: [{ content: { parts: [{
        text: '{"action":"control","deviceId":"d1","state":true,"message":"Ligando"}',
      }] } }] } });                                                    // lite atende

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz'))
      .resolves.toMatchObject({ action: 'control', deviceId: 'd1' });

    // Confirma que a segunda chamada usou o OUTRO modelo, e não repetiu o primeiro.
    expect(ax.post.mock.calls[0][0]).toMatch(/gemini-2\.5-flash:/);
    expect(ax.post.mock.calls[1][0]).toMatch(/gemini-2\.5-flash-lite:/);
  });

  test('não insiste num modelo que já recusou', async () => {
    // Sem esta memória, todo comando pagaria de novo o 404 do preferido —
    // uma ida à rede inútil na frente de cada resposta ao usuário.
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash', 'gemini-2.5-pro']));
    const ok = { data: { candidates: [{ content: { parts: [{
      text: '{"action":"list","message":"ok"}',
    }] } }] } };
    ax.post
      .mockRejectedValueOnce(um404)   // 1o comando: flash recusa
      .mockResolvedValueOnce(ok)      // 1o comando: pro atende
      .mockResolvedValueOnce(ok);     // 2o comando: vai direto no pro

    await fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz');
    await fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz');

    expect(ax.post).toHaveBeenCalledTimes(3);
    expect(ax.post.mock.calls[2][0]).toMatch(/gemini-2\.5-pro:/);
  });

  test('todos recusando dá erro que nomeia o que foi tentado', async () => {
    // A mensagem tem que dizer o que foi testado: sem isso, quem configurou a
    // chave não sabe se o problema é o modelo, a chave ou a API desabilitada.
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash', 'gemini-2.5-pro']));
    ax.post.mockRejectedValue(um404);

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz'))
      .rejects.toThrow(/gemini-2\.5-flash.*gemini-2\.5-pro/);
  });

  test('para depois de poucas tentativas, sem varrer o catálogo', async () => {
    // Cada tentativa é uma ida à rede com o usuário esperando.
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos([
      'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
      'gemini-2.0-flash', 'gemini-1.0-pro',
    ]));
    ax.post.mockRejectedValue(um404);

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz')).rejects.toThrow();
    expect(ax.post.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test('erro que não é 404 não vira tentativa extra', async () => {
    // Repetir não resolve cota estourada nem chave inválida: só faria o
    // usuário esperar mais para ver a mesma mensagem.
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash', 'gemini-2.5-pro']));
    ax.post.mockRejectedValueOnce({
      response: { status: 429, data: { error: { message: 'Quota exceeded' } } },
    });

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz'))
      .rejects.toThrow(/Quota exceeded/);
    expect(ax.post).toHaveBeenCalledTimes(1);
  });
});

describe('Erros do Gemini chegam legíveis', () => {

  test('mensagem do Google é repassada em vez de engolida', async () => {
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash']));
    ax.post.mockRejectedValueOnce({
      response: { status: 429, data: { error: { message: 'Quota exceeded' } } },
    });

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz'))
      .rejects.toThrow(/Quota exceeded/);
  });

  test('resposta vazia não vira erro de parse', async () => {
    // Acontece quando o filtro de segurança do Google bloqueia a saída: a
    // resposta chega 200, mas sem candidates. Antes, isso estourava num
    // TypeError sobre propriedade de undefined.
    const { axios: ax, interpretCommand: fn } = moduloLimpo();
    ax.get.mockResolvedValueOnce(listaDeModelos(['gemini-2.5-flash']));
    ax.post.mockResolvedValueOnce({ data: { candidates: [] } });

    await expect(fn([{ name: 'Luz', tuya_id: 'd1' }], 'liga a luz'))
      .rejects.toThrow(/não devolveu resposta/i);
  });
});
