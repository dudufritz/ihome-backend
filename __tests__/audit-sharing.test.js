/**
 * audit-sharing.test.js — Auditoria de compartilhamento e credenciais
 *
 * Cobre as acoes que ate entao nao deixavam rastro: convidar, aceitar,
 * recusar, revogar, sair da casa e trocar a credencial Tuya.
 *
 * O teste mais importante do arquivo e o ultimo: prova que o segredo Tuya
 * nao vaza para a tabela de auditoria. Cifrar o segredo no banco e depois
 * copia-lo para o log anularia a protecao inteira, e a auditoria e visivel
 * para todo mundo com quem a casa foi compartilhada.
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
// O servico de e-mail entra mockado (e nao o nodemailer) para que cada teste
// controle se o envio do convite deu certo ou falhou.
jest.mock('../src/services/mail.service', () => ({
  sendInviteEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  mailTransport: { sendMail: jest.fn().mockResolvedValue({ messageId: 'x' }) },
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { sendInviteEmail } = require('../src/services/mail.service');

let app;
beforeAll(() => { app = require('../index').app; });

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  jest.clearAllMocks();
  sendInviteEmail.mockResolvedValue(undefined);
});

const OWNER = 'dono@ihome.com';
const GUEST = 'convidado@ihome.com';

function tok(email = OWNER, sub = 'u1') {
  return jwt.sign({ email, sub }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

/** Todas as chamadas de INSERT na audit_log feitas durante o teste. */
function auditInserts() {
  return mockQuery.mock.calls.filter((c) => /INSERT INTO audit_log/i.test(c[0]));
}

/**
 * Le a primeira linha de auditoria gravada, ja com o details desserializado.
 * A ordem dos parametros acompanha o INSERT do audit.service.
 */
function primeiroRegistro() {
  const [, params] = auditInserts()[0];
  return {
    homeOwner: params[0],
    actor: params[1],
    action: params[2],
    details: params[5] ? JSON.parse(params[5]) : null,
    result: params[6],
    errorMessage: params[7],
  };
}

// ── CONVITE ───────────────────────────────────────────────────
describe('Auditoria — convidar alguem para a casa', () => {
  test('registra share.invite com convidado e permissao no resumo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, owner_email: OWNER, guest_email: GUEST, permission: 'control' }],
      rowCount: 1,
    });

    await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: GUEST, permission: 'control' })
      .expect(200);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('share.invite');
    expect(reg.homeOwner).toBe(OWNER);
    expect(reg.actor).toBe(OWNER);
    expect(reg.details.summary).toContain(GUEST);
    expect(reg.details.summary).toContain('ver e controlar');
    expect(reg.details.emailSent).toBe(true);
  });

  test('permissao de apenas ver aparece descrita no resumo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 2, owner_email: OWNER, guest_email: GUEST, permission: 'view' }],
      rowCount: 1,
    });

    await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: GUEST, permission: 'view' })
      .expect(200);

    expect(primeiroRegistro().details.summary).toContain('apenas ver');
  });

  test('falha no envio do e-mail nao impede o registro do convite', async () => {
    // O convite existe no banco mesmo sem o e-mail sair. O resultado descreve
    // a acao auditada (convidar), e nao o envio — que fica em emailSent.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 3, owner_email: OWNER, guest_email: GUEST, permission: 'control' }],
      rowCount: 1,
    });
    sendInviteEmail.mockRejectedValueOnce(new Error('SMTP fora do ar'));

    await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: GUEST })
      .expect(200);

    const reg = primeiroRegistro();
    expect(reg.result).toBe('success');
    expect(reg.details.emailSent).toBe(false);
    expect(reg.errorMessage).toBe('SMTP fora do ar');
  });

  test('convite rejeitado por validacao nao gera registro', async () => {
    // Convidar a si mesmo para antes de tocar o banco: nada aconteceu,
    // entao nao ha o que auditar.
    await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: OWNER })
      .expect(400);

    expect(auditInserts()).toHaveLength(0);
  });
});

// ── ACEITE E RECUSA (rotas publicas) ──────────────────────────
describe('Auditoria — aceite e recusa pelo link do e-mail', () => {
  test('aceite registra o convidado como ator, mesmo sem sessao', async () => {
    // Esta rota e publica: quem clica no link esta no e-mail do convidado e
    // nao tem token. O ator vem da propria linha do convite.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, owner_email: OWNER, guest_email: GUEST, permission: 'control' }],
      rowCount: 1,
    });

    await request(app).get('/shares/accept/token-valido').expect(302);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('share.accept');
    expect(reg.actor).toBe(GUEST);       // o convidado, nao o dono
    expect(reg.homeOwner).toBe(OWNER);   // na casa do dono
    expect(reg.details.summary).toContain('Aceitou');
  });

  test('token invalido ou expirado nao gera registro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get('/shares/accept/token-que-nao-existe').expect(302);

    expect(auditInserts()).toHaveLength(0);
  });

  test('recusa registra share.decline com o convidado como ator', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, owner_email: OWNER, guest_email: GUEST, permission: 'view' }],
      rowCount: 1,
    });

    await request(app).get('/shares/decline/token-valido').expect(302);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('share.decline');
    expect(reg.actor).toBe(GUEST);
    expect(reg.homeOwner).toBe(OWNER);
  });
});

// ── REVOGACAO E SAIDA ─────────────────────────────────────────
describe('Auditoria — revogar acesso e sair da casa', () => {
  test('revogacao registra quem perdeu o acesso e se o convite tinha sido aceito', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 7, owner_email: OWNER, guest_email: GUEST, permission: 'control', status: 'accepted' }],
      rowCount: 1,
    });

    await request(app)
      .delete('/shares/7')
      .set('Authorization', `Bearer ${tok()}`)
      .expect(200);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('share.revoke');
    expect(reg.details.summary).toContain(GUEST);
    expect(reg.details.statusAnterior).toBe('accepted');
  });

  test('revogar compartilhamento inexistente devolve 404 e nao registra', async () => {
    // Antes esta rota respondia success sem apagar nada: a tela dizia que o
    // acesso tinha sido revogado enquanto ele continuava valendo.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .delete('/shares/999')
      .set('Authorization', `Bearer ${tok()}`)
      .expect(404);

    expect(auditInserts()).toHaveLength(0);
  });

  test('convidado que sai registra a acao na casa do dono', async () => {
    // O caso que justifica a auditoria separar casa de ator: quem age e o
    // convidado, mas quem precisa ver o registro e o dono.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 9, owner_email: OWNER, guest_email: GUEST, permission: 'control', status: 'accepted' }],
      rowCount: 1,
    });

    await request(app)
      .delete('/shared-with-me/9')
      .set('Authorization', `Bearer ${tok(GUEST, 'u2')}`)
      .expect(200);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('share.leave');
    expect(reg.actor).toBe(GUEST);
    expect(reg.homeOwner).toBe(OWNER);
  });
});

// ── CREDENCIAIS ───────────────────────────────────────────────
describe('Auditoria — troca de credencial Tuya', () => {
  test('registra credentials.update com o Access ID mascarado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app)
      .post('/tuya-credentials')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ tuya_access_id: 'abcdefgh1234', tuya_secret: 'segredo-super-secreto', tuya_base_url: 'https://openapi.tuyaus.com' })
      .expect(200);

    const reg = primeiroRegistro();
    expect(reg.action).toBe('credentials.update');
    expect(reg.details.accessIdMascarado).toBe('••••••••1234');
    expect(reg.details.accessIdMascarado).not.toContain('abcdefgh');
  });

  test('O SEGREDO TUYA NAO APARECE EM NENHUM CAMPO DO REGISTRO', async () => {
    // Este teste existe para falhar se alguem, no futuro, achar util incluir
    // "so o comeco" do segredo no log para facilitar depuracao.
    const SEGREDO = 'ff00ff00segredo-que-nao-pode-vazar';
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app)
      .post('/tuya-credentials')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ tuya_access_id: 'abcdefgh1234', tuya_secret: SEGREDO })
      .expect(200);

    // Varre a linha inteira, campo a campo, e nao apenas o details.
    const [, params] = auditInserts()[0];
    const linhaInteira = JSON.stringify(params);
    expect(linhaInteira).not.toContain(SEGREDO);
    expect(linhaInteira).not.toContain('ff00ff00');
  });

  test('credencial incompleta e rejeitada sem gerar registro', async () => {
    await request(app)
      .post('/tuya-credentials')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ tuya_access_id: 'abcdefgh1234' })
      .expect(400);

    expect(auditInserts()).toHaveLength(0);
  });
});
