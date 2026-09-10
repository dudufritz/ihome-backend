/**
 * jobs.test.js — Rotinas em segundo plano.
 *
 * Cobre monitor.job (deteccao de transicao online/offline), scheduler.job
 * (execucao de rotinas por horario) e o esquema do banco.
 */
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
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const axios = require('axios');
const { monitorDevices } = require('../src/jobs/monitor.job');
const { runSchedules, horaAtual } = require('../src/jobs/scheduler.job');
const { initDB } = require('../src/db/schema');
const { tokenCache } = require('../src/services/tuya.service');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  axios.mockReset();
  axios.get = jest.fn();
  axios.post = jest.fn();
  Object.keys(tokenCache).forEach((k) => delete tokenCache[k]);
});

/** Localiza a primeira query que casa com um padrao. */
function queryComendo(regex) {
  return mockQuery.mock.calls.find((c) => regex.test(c[0]));
}

/** Prepara os mocks comuns: 1 usuario, 1 dispositivo, credenciais validas. */
function mockUsuarioComDispositivo() {
  mockQuery.mockResolvedValueOnce({ rows: [{ user_email: 'dono@ihome.com' }], rowCount: 1 }); // usuarios
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
    rowCount: 1,
  }); // getUserTuya
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_id: 'd1', name: 'Lampada da Sala' }], rowCount: 1,
  }); // dispositivos
}

// ═══════════════════════════════════════════════════════════════
// MONITOR DE CONECTIVIDADE
// ═══════════════════════════════════════════════════════════════
describe('monitor.job — deteccao de transicao', () => {
  test('sem usuarios com credenciais, nada acontece', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await monitorDevices();
    expect(mockQuery).toHaveBeenCalledTimes(1); // so a consulta inicial
  });

  test('dispositivo que responde e ja estava online NAO gera alerta', async () => {
    mockUsuarioComDispositivo();
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { result: [{ code: 'switch_1', value: true }] } });
    mockQuery.mockResolvedValueOnce({ rows: [{ online: true }], rowCount: 1 }); // cache: ja online

    await monitorDevices();

    // Alertar a cada ciclo com o estado inalterado inundaria o usuario.
    expect(queryComendo(/INSERT INTO user_alerts/i)).toBeUndefined();
    // Mas o cache e atualizado de qualquer forma.
    expect(queryComendo(/INSERT INTO device_status_cache/i)).toBeDefined();
  });

  test('transicao offline -> online gera alerta de retorno', async () => {
    mockUsuarioComDispositivo();
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { result: [] } });
    mockQuery.mockResolvedValueOnce({ rows: [{ online: false }], rowCount: 1 }); // estava offline

    await monitorDevices();

    const alerta = queryComendo(/INSERT INTO user_alerts/i);
    expect(alerta).toBeDefined();
    expect(alerta[1]).toContain('online');
    expect(alerta[1]).toContain('Lampada da Sala');
  });

  test('transicao online -> offline gera alerta de queda', async () => {
    mockUsuarioComDispositivo();
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockRejectedValueOnce(new Error('device unreachable')); // consulta falha
    mockQuery.mockResolvedValueOnce({ rows: [{ online: true }], rowCount: 1 }); // estava online

    await monitorDevices();

    const alerta = queryComendo(/INSERT INTO user_alerts/i);
    expect(alerta).toBeDefined();
    expect(alerta[1]).toContain('offline');
  });

  test('primeira deteccao sem cache tambem alerta quando offline', async () => {
    mockUsuarioComDispositivo();
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockRejectedValueOnce(new Error('unreachable'));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // cache vazio

    await monitorDevices();
    expect(queryComendo(/INSERT INTO user_alerts/i)).toBeDefined();
  });

  test('dispositivo que continua offline NAO alerta de novo', async () => {
    mockUsuarioComDispositivo();
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockRejectedValueOnce(new Error('unreachable'));
    mockQuery.mockResolvedValueOnce({ rows: [{ online: false }], rowCount: 1 }); // ja estava offline

    await monitorDevices();
    expect(queryComendo(/INSERT INTO user_alerts/i)).toBeUndefined();
  });

  test('erro em um usuario nao interrompe o ciclo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_email: 'a@x.com' }, { user_email: 'b@x.com' }], rowCount: 2,
    });
    mockQuery.mockRejectedValueOnce(new Error('credencial invalida')); // getUserTuya de A falha
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });        // getUserTuya de B: sem config

    // O importante e nao lancar: o job precisa sobreviver a um usuario ruim.
    await expect(monitorDevices()).resolves.toBeUndefined();
  });

  test('falha na consulta inicial e capturada', async () => {
    mockQuery.mockRejectedValueOnce(new Error('banco fora do ar'));
    await expect(monitorDevices()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// AGENDAMENTOS
// ═══════════════════════════════════════════════════════════════
describe('scheduler.job — rotinas por horario', () => {
  test('horaAtual devolve HH:MM com zero a esquerda', () => {
    const h = horaAtual();
    expect(h).toMatch(/^\d{2}:\d{2}$/);
  });

  test('nenhum agendamento no minuto atual: nenhuma chamada a Tuya', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        device_id: 'd1', device_name: 'Lamp', on_time: '99:99', off_time: '88:88',
        tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://x',
      }],
      rowCount: 1,
    });
    await runSchedules();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('agendamento no minuto atual liga o dispositivo', async () => {
    const agora = horaAtual();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        device_id: 'd1', device_name: 'Lamp', on_time: agora, off_time: null,
        tuya_access_id: 'acc', tuya_secret: 'sec',
        tuya_base_url: 'https://openapi.tuyaus.com',
      }],
      rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { success: true } });

    await runSchedules();

    // Confere que o comando enviado foi "ligar" (switch_1 = true).
    const chamada = axios.mock.calls[0][0];
    expect(chamada.url).toContain('/devices/d1/commands');
    expect(chamada.data.commands[0]).toEqual({ code: 'switch_1', value: true });
  });

  test('horario de desligar envia switch_1 = false', async () => {
    const agora = horaAtual();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        device_id: 'd2', device_name: 'TV', on_time: null, off_time: agora,
        tuya_access_id: 'acc', tuya_secret: 'sec',
        tuya_base_url: 'https://openapi.tuyaus.com',
      }],
      rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { success: true } });

    await runSchedules();
    expect(axios.mock.calls[0][0].data.commands[0]).toEqual({ code: 'switch_1', value: false });
  });

  test('credencial que nao decifra e pulada sem derrubar o job', async () => {
    const agora = horaAtual();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        user_email: 'x@y.com', device_id: 'd1', device_name: 'Lamp',
        on_time: agora, off_time: null,
        tuya_access_id: 'acc',
        tuya_secret: 'enc:v1:formato:invalido', // nao decifra
        tuya_base_url: 'https://x',
      }],
      rowCount: 1,
    });

    await expect(runSchedules()).resolves.toBeUndefined();
    expect(axios.get).not.toHaveBeenCalled(); // nem tentou falar com a Tuya
  });

  test('falha no banco e capturada', async () => {
    mockQuery.mockRejectedValueOnce(new Error('sem conexao'));
    await expect(runSchedules()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// ESQUEMA DO BANCO
// ═══════════════════════════════════════════════════════════════
describe('db/schema — initDB', () => {
  test('cria todas as tabelas e os indices de auditoria', async () => {
    await initDB();
    const sqls = mockQuery.mock.calls.map((c) => c[0]).join('\n');

    for (const tabela of [
      'user_tuya_config', 'user_devices', 'user_schedules', 'user_alerts',
      'device_status_cache', 'home_shares', 'push_subscriptions', 'audit_log',
    ]) {
      expect(sqls).toContain(tabela);
    }
    expect(sqls).toContain('idx_audit_home');
    expect(sqls).toContain('idx_audit_actor');
  });

  test('e idempotente: tudo usa IF NOT EXISTS', async () => {
    await initDB();
    const creates = mockQuery.mock.calls
      .map((c) => c[0])
      .filter((s) => /CREATE (TABLE|INDEX)/i.test(s));

    // Rodar initDB a cada boot so e seguro porque nenhuma instrucao falha
    // quando o objeto ja existe.
    expect(creates.length).toBeGreaterThan(0);
    creates.forEach((sql) => expect(sql).toMatch(/IF NOT EXISTS/i));
  });
});
