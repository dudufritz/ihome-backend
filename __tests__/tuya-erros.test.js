/**
 * tuya-erros.test.js — Tradução das falhas da Tuya.
 *
 * O caso que originou este arquivo: a descoberta de dispositivos falhava com
 * `{"code":2009,"msg":"clientId is invalid"}` despejado cru na tela. A mensagem
 * induz ao erro — parece credencial inválida, quando significa que o Access ID
 * foi consultado no centro de dados errado. Quem via isso ia regerar
 * credenciais que já estavam corretas.
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';

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

const { explicarErroTuya, REGIOES } = require('../src/services/tuya.service');

const US = 'https://openapi.tuyaus.com';

describe('Tradução dos erros da Tuya', () => {
  test('2009 aponta a região, não a credencial', () => {
    const msg = explicarErroTuya(
      { code: 2009, msg: 'clientId is invalid', success: false }, US
    );
    expect(msg).toContain('Western America');   // diz ONDE perguntou
    expect(msg).toContain('Data Center');       // diz ONDE conferir
    expect(msg).toContain('2009');              // preserva o código original
  });

  test('1004 aponta o Access Secret', () => {
    const msg = explicarErroTuya({ code: 1004, msg: 'sign invalid' }, US);
    expect(msg).toContain('Access Secret');
    expect(msg).not.toContain('Data Center');   // não confunde com região
  });

  test('1106 aponta a permissão de API do projeto', () => {
    const msg = explicarErroTuya({ code: 1106, msg: 'permission deny' }, US);
    expect(msg).toContain('Service API');
  });

  test('1100 aponta a vinculação com o app Smart Life', () => {
    const msg = explicarErroTuya({ code: 1100, msg: 'no device' }, US);
    expect(msg).toContain('Link Tuya App Account');
  });

  test('código desconhecido preserva a mensagem original', () => {
    // Perder informação seria pior que mostrar algo técnico: sem a mensagem
    // original, um erro novo da Tuya viraria "falhou" e nada mais.
    const msg = explicarErroTuya({ code: 9999, msg: 'algo novo e inesperado' }, US);
    expect(msg).toContain('algo novo e inesperado');
    expect(msg).toContain('9999');
  });

  test('região desconhecida cai para a própria URL', () => {
    const msg = explicarErroTuya({ code: 2009, msg: 'x' }, 'https://openapi.exemplo.com');
    expect(msg).toContain('https://openapi.exemplo.com');
  });

  test('as seis regiões da Tuya estão mapeadas', () => {
    // O seletor do frontend precisa oferecer todas: faltando uma, quem criou
    // o projeto naquele centro de dados não consegue configurar o app.
    expect(Object.keys(REGIOES)).toHaveLength(6);
    expect(Object.values(REGIOES)).toEqual(
      expect.arrayContaining([
        'Western America', 'Eastern America',
        'Central Europe', 'Western Europe',
        'China', 'India',
      ])
    );
  });
});
