/**
 * rotinas-auditoria.test.js — Rotinas agendadas entram no registro de auditoria.
 *
 * O CASO QUE ESTES TESTES PROTEGEM
 *
 * O scheduler acionava dispositivos e deixava como único vestígio um
 * `console.log`. A luz acendia às 22h e a tela de Auditoria — que existe para
 * responder "quem mexeu no quê" — não mostrava nada. Quem olhasse concluiria
 * que ninguém havia mexido.
 *
 * E o log mentia: o `.catch` engolia o erro da Tuya e a linha seguinte
 * imprimia "Ligou" de qualquer jeito. O único registro existente afirmava
 * sucesso em cima de uma falha.
 *
 * Por isso os testes abaixo verificam duas coisas separadas: que a ação é
 * REGISTRADA, e que o resultado registrado é o que de fato aconteceu.
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const mockQuery = jest.fn();

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    query: mockQuery,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});

// O serviço Tuya é mockado inteiro: o que se testa aqui é o que o scheduler
// faz com o resultado, não a assinatura HMAC.
jest.mock('../src/services/tuya.service', () => ({
  tuyaRequest: jest.fn(),
}));

// decrypt devolve o texto como está. Um dos testes sobrescreve isso para
// simular credencial ilegível.
jest.mock('../src/services/crypto.service', () => ({
  decrypt: jest.fn((v) => v),
}));

jest.mock('../src/services/audit.service', () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  describeCommands: jest.requireActual('../src/services/audit.service').describeCommands,
}));

const { tuyaRequest } = require('../src/services/tuya.service');
const { decrypt } = require('../src/services/crypto.service');
const { recordAudit } = require('../src/services/audit.service');
const { runSchedules, horaAtual } = require('../src/jobs/scheduler.job');

/**
 * Linha do JOIN que o scheduler consulta, com o horário de ligar já ajustado
 * para o minuto corrente — senão a rotina não dispararia durante o teste.
 */
function rotina(overrides = {}) {
  return {
    id: 1,
    user_email: 'eduardo@test.com',
    device_id: 'tuya-123',
    device_name: 'Lâmpada do quarto',
    on_time: horaAtual(),
    off_time: '23:59',
    active: true,
    tuya_access_id: 'id-x',
    tuya_secret: 'segredo-cifrado',
    tuya_base_url: 'https://openapi.tuyaus.com',
    room: 'Quarto',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  decrypt.mockImplementation((v) => v);
  tuyaRequest.mockResolvedValue({ success: true });
});

describe('Rotina executada com sucesso', () => {
  test('registra a ação na auditoria', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    await runSchedules();

    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.action).toBe('device.command');
    expect(dados.result).toBe('success');
    expect(dados.deviceName).toBe('Lâmpada do quarto');
  });

  test('o ator é o dono da rotina, não um usuário anônimo', async () => {
    // A rotina foi criada por uma pessoa; a responsabilidade é dela, mesmo
    // que o disparo tenha sido automático.
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    await runSchedules();

    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.actorEmail).toBe('eduardo@test.com');
    expect(dados.homeOwnerEmail).toBe('eduardo@test.com');
  });

  test('marca a origem como rotina', async () => {
    // Sem isto, a linha apareceria como "Você · Ligou" às 22h e pareceria
    // que a pessoa estava acordada mexendo no app.
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    await runSchedules();

    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.details.via).toBe('rotina');
  });

  test('registra o cômodo e o horário programado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rotina({ on_time: horaAtual() })], rowCount: 1 });
    await runSchedules();

    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.details.room).toBe('Quarto');
    expect(dados.details.horario).toBe(horaAtual());
  });

  test('o resumo legível descreve a ação', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    await runSchedules();

    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.details.summary).toBe('Ligou');
  });

  test('não passa requisição, porque não houve nenhuma', async () => {
    // O primeiro argumento null é o que faz a auditoria gravar IP e
    // user-agent vazios — a leitura correta de "partiu do servidor".
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    await runSchedules();

    expect(recordAudit.mock.calls[0][0]).toBeNull();
  });
});

describe('Rotina que falha', () => {
  test('registra erro, e não sucesso', async () => {
    // Este é o bug antigo: o console imprimia "Ligou" mesmo quando a Tuya
    // recusava o comando.
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    tuyaRequest.mockRejectedValueOnce(new Error('device offline'));

    await runSchedules();

    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.result).toBe('error');
    expect(dados.errorMessage).toMatch(/device offline/);
  });

  test('falha de uma rotina não impede as outras do mesmo minuto', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        rotina({ id: 1, device_id: 'a', device_name: 'Luz A' }),
        rotina({ id: 2, device_id: 'b', device_name: 'Luz B' }),
      ],
      rowCount: 2,
    });
    tuyaRequest
      .mockRejectedValueOnce(new Error('falhou'))
      .mockResolvedValueOnce({ success: true });

    await runSchedules();

    expect(recordAudit).toHaveBeenCalledTimes(2);
    expect(recordAudit.mock.calls[0][1].result).toBe('error');
    expect(recordAudit.mock.calls[1][1].result).toBe('success');
  });

  test('credencial ilegível vira registro de falha, não silêncio', async () => {
    // Acontece com quem trocou a ENCRYPTION_KEY do servidor: as rotinas
    // param e nada na tela explica por quê.
    mockQuery.mockResolvedValueOnce({ rows: [rotina()], rowCount: 1 });
    decrypt.mockImplementation(() => { throw new Error('bad key'); });

    await runSchedules();

    expect(tuyaRequest).not.toHaveBeenCalled();
    const [, dados] = recordAudit.mock.calls[0];
    expect(dados.result).toBe('error');
    expect(dados.errorMessage).toMatch(/ileg[íi]vel/i);
  });
});

describe('Quando não há nada a fazer', () => {
  test('rotina fora do horário não aciona nem registra', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [rotina({ on_time: '00:01', off_time: '00:02' })],
      rowCount: 1,
    });
    await runSchedules();

    expect(tuyaRequest).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  test('erro na consulta ao banco não derruba o job', async () => {
    mockQuery.mockRejectedValueOnce(new Error('conexão perdida'));
    await expect(runSchedules()).resolves.toBeUndefined();
  });
});
