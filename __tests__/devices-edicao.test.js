/**
 * devices-edicao.test.js — Editar dispositivo e detectar o que é controlável.
 *
 * Os dois vieram do mesmo relato de uso real: depois de importar 38
 * dispositivos da conta Tuya, não havia como corrigir nome nem cômodo, e
 * sensores apareciam com botão de ligar — que não fazia nada, porque sensor
 * não aceita comando.
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
  setVapidDetails: jest.fn(), sendNotification: jest.fn().mockResolvedValue({}), generateVAPIDKeys: jest.fn(),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: 'x' }) })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');

let app, tokenCache;
beforeAll(() => { const m = require('../index'); app = m.app; tokenCache = m.tokenCache; });

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  jest.clearAllMocks();
  axios.get = jest.fn();
  if (tokenCache) Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
});

const DONO = 'dono@ihome.com';
const tok = (email = DONO) => jwt.sign({ email, sub: 'u1' }, process.env.JWT_SECRET, { algorithm: 'HS256' });

/** Prepara credenciais Tuya válidas e o token de acesso. */
function mockCredenciais() {
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
    rowCount: 1,
  });
  axios.get.mockResolvedValueOnce({
    data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
  });
}

// ── EDIÇÃO ────────────────────────────────────────────────────
describe('PUT /my-devices/:id — renomear e mudar de cômodo', () => {
  test('atualiza nome e cômodo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 5, name: 'Luz da Sala', room: 'Sala' }], rowCount: 1,
    });
    const r = await request(app).put('/my-devices/5')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ name: 'Luz da Sala', room: 'Sala' });

    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Luz da Sala');
    // O e-mail entra na cláusula: é o que impede editar dispositivo alheio.
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(DONO);
  });

  test('apara espaços nas pontas', async () => {
    // Colar do painel da Tuya costuma trazer espaço invisível junto.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    await request(app).put('/my-devices/5')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ name: '  Luz da Sala  ', room: '  Sala  ' });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('Luz da Sala');
    expect(params[1]).toBe('Sala');
  });

  test('nome vazio é recusado antes de tocar o banco', async () => {
    const r = await request(app).put('/my-devices/5')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ name: '   ' });

    expect(r.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('enviar só o cômodo preserva o nome', async () => {
    // COALESCE: o campo omitido mantém o valor atual em vez de virar nulo.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    await request(app).put('/my-devices/5')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ room: 'Cozinha' });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBeNull();      // nome não enviado
    expect(params[1]).toBe('Cozinha');
  });

  test('dispositivo de outro usuário devolve 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).put('/my-devices/999')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ name: 'Tentativa' });

    expect(r.status).toBe(404);
  });
});

// ── CONTROLÁVEL OU NÃO ────────────────────────────────────────
describe('GET /devices — quem tem botão de ligar', () => {
  test('aparelho que reporta switch_1 é controlável', async () => {
    mockCredenciais();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tuya_id: 'd1', name: 'Lâmpada', room: 'Sala', category: 'dj' }], rowCount: 1,
    });
    axios.mockResolvedValueOnce({ data: { result: [{ code: 'switch_1', value: true }] } });

    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    const d = r.body.result.list[0];
    expect(d.isControllable).toBe(true);
    expect(d.switchCode).toBe('switch_1');
    expect(d.switch_1).toBe(true);
  });

  test('sensor de presença NÃO é controlável', async () => {
    // O caso que motivou a mudança: antes, isControllable era fixo em true e
    // a tela mostrava um botão que não fazia nada.
    mockCredenciais();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 2, tuya_id: 'd2', name: 'Sensor', room: 'Corredor', category: 'pir' }], rowCount: 1,
    });
    axios.mockResolvedValueOnce({
      data: { result: [{ code: 'pir', value: 'pir' }, { code: 'battery_percentage', value: 90 }] },
    });

    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    const d = r.body.result.list[0];
    expect(d.isControllable).toBe(false);
    expect(d.switchCode).toBeNull();
  });

  test('reconhece códigos alternativos de interruptor', async () => {
    // Nem todo aparelho usa switch_1; fitas de LED costumam usar switch_led.
    mockCredenciais();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 3, tuya_id: 'd3', name: 'Fita LED', room: '', category: 'dd' }], rowCount: 1,
    });
    axios.mockResolvedValueOnce({ data: { result: [{ code: 'switch_led', value: false }] } });

    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    const d = r.body.result.list[0];
    expect(d.isControllable).toBe(true);
    expect(d.switchCode).toBe('switch_led');
    expect(d.switch_1).toBe(false);
  });

  test('offline não oferece botão', async () => {
    // Sem resposta do aparelho não dá para saber o que ele aceita. Prometer
    // um controle que pode não existir é pior que omitir.
    mockCredenciais();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 4, tuya_id: 'd4', name: 'Tomada', room: 'Quarto', category: 'cz' }], rowCount: 1,
    });
    axios.mockRejectedValueOnce(new Error('sem resposta'));

    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    const d = r.body.result.list[0];
    expect(d.online).toBe(false);
    expect(d.isControllable).toBe(false);
  });

  test('a categoria guardada chega na tela', async () => {
    // Antes vinha 'Switch' fixo para todo mundo, então o ícone era sempre o
    // mesmo, independente do aparelho.
    mockCredenciais();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 5, tuya_id: 'd5', name: 'Câmera', room: 'Entrada', category: 'sp' }], rowCount: 1,
    });
    axios.mockResolvedValueOnce({ data: { result: [] } });

    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.body.result.list[0].category_name).toBe('sp');
  });
});
