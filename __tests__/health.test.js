/**
 * health.test.js — Rotas públicas de diagnóstico.
 *
 * NOTA SOBRE A VERSÃO ANTERIOR DESTE ARQUIVO: ela montava um Express próprio
 * dentro do teste, com rotas escritas à mão que imitavam as reais, e verificava
 * esse app improvisado. Passava sempre — inclusive se as rotas de verdade
 * fossem apagadas, porque nunca chegava a carregá-las.
 *
 * Um teste que não importa o código que diz cobrir não é um teste: é uma
 * afirmação. Agora a suíte usa o app real, como os demais arquivos.
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => {
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

const request = require('supertest');

let app;
beforeAll(() => { app = require('../index').app; });

describe('Rotas públicas de diagnóstico', () => {
  test('GET / confirma que a API subiu', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('iHome API');
  });

  test('GET /health responde ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /health informa se o push está pronto', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('push');
    // Sem chaves VAPID no ambiente de teste, o push não pode estar pronto.
    expect(res.body.push).toBe(false);
  });

  test('GET /health relata quais configurações estão presentes', async () => {
    // O motivo de existir: processo no ar e processo funcionando são coisas
    // diferentes. Sem banco ou sem JWT o servidor sobe e nenhum login funciona.
    const res = await request(app).get('/health');
    expect(res.body.config).toEqual(
      expect.objectContaining({
        database: true,   // definida no topo deste arquivo
        auth: true,       // idem
        frontendUrl: expect.any(Boolean),
        ai: expect.any(Boolean),
        email: expect.any(Boolean),
      })
    );
  });

  test('GET /health NÃO revela o estado da chave de cifragem', async () => {
    // Ausência proposital: dizer que a ENCRYPTION_KEY falta revelaria que os
    // segredos Tuya estão em texto puro no banco — informação sobre proteção
    // em repouso, que não se observa de fora. Os outros campos só confirmam
    // algo que qualquer tentativa de login já denunciaria.
    const res = await request(app).get('/health');
    expect(res.body.config).not.toHaveProperty('encryption');
    expect(JSON.stringify(res.body)).not.toMatch(/encryption/i);
  });

  test('GET /health nunca devolve o valor de uma variável', async () => {
    // Blindagem contra alguém achar prático incluir "só o começo" de um segredo
    // para facilitar a depuração.
    const res = await request(app).get('/health');
    Object.values(res.body.config).forEach((v) => {
      expect(typeof v).toBe('boolean');
    });
    expect(JSON.stringify(res.body)).not.toContain('test-secret-key');
    expect(JSON.stringify(res.body)).not.toContain('postgresql://');
  });

  test('GET /vapid-public-key devolve string vazia sem chave configurada', async () => {
    const res = await request(app).get('/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');
    expect(res.body.key).toBe('');
  });

  test('rota inexistente retorna 404', async () => {
    const res = await request(app).get('/rota-que-nao-existe');
    expect(res.status).toBe(404);
  });
});
