/**
 * security.test.js — Testes das regras de seguranca introduzidas na v1.1.
 *
 * Cobre tres assuntos independentes:
 *   1. crypto.service  — cifragem AES-256-GCM do segredo Tuya;
 *   2. utils/email     — normalizacao que faz o compartilhamento funcionar;
 *   3. sharing.service — autorizacao de casas compartilhadas.
 *
 * Sao funcoes puras (ou quase), entao os testes sao diretos: entra X, sai Y.
 */

// Chave de 32 bytes em hexadecimal, usada apenas nos testes.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    query: mockQuery,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});

const { encrypt, decrypt, isEncrypted, isEncryptionEnabled } = require('../src/services/crypto.service');
const { normalizeEmail, isValidEmail } = require('../src/utils/email');
const { resolveHomeAccess, PERMISSOES_VALIDAS } = require('../src/services/sharing.service');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ═══════════════════════════════════════════════════════════════
// 1. CRIPTOGRAFIA DO SEGREDO TUYA
// ═══════════════════════════════════════════════════════════════
describe('crypto.service — AES-256-GCM', () => {
  test('a chave de teste e reconhecida como valida', () => {
    expect(isEncryptionEnabled()).toBe(true);
  });

  test('cifrar e decifrar devolve o texto original', () => {
    const segredo = 'meu-tuya-secret-super-sigiloso';
    const cifrado = encrypt(segredo);

    expect(cifrado).not.toBe(segredo);        // realmente mudou
    expect(cifrado).toMatch(/^enc:v1:/);      // formato esperado
    expect(decrypt(cifrado)).toBe(segredo);   // volta ao original
  });

  test('o texto cifrado nao contem o segredo em claro', () => {
    const cifrado = encrypt('abc123');
    expect(cifrado).not.toContain('abc123');
  });

  test('cifrar o mesmo valor duas vezes gera resultados diferentes', () => {
    // Cada chamada usa um IV aleatorio novo. Sem isso, dois usuarios com a
    // mesma credencial teriam linhas identicas no banco — o que revelaria
    // essa coincidencia a quem tivesse acesso de leitura.
    const a = encrypt('mesmo-segredo');
    const b = encrypt('mesmo-segredo');
    expect(a).not.toBe(b);
    // ...mas ambos decifram para o mesmo valor
    expect(decrypt(a)).toBe(decrypt(b));
  });

  test('valor legado em texto puro passa intacto (compatibilidade)', () => {
    // Linhas gravadas antes desta funcionalidade nao tem o prefixo.
    // Precisam continuar funcionando para a migracao ocorrer sem downtime.
    expect(isEncrypted('segredo-antigo')).toBe(false);
    expect(decrypt('segredo-antigo')).toBe('segredo-antigo');
  });

  test('adulteracao do texto cifrado e detectada', () => {
    const cifrado = encrypt('valor-original');
    // Troca o ultimo caractere hexadecimal do payload.
    const ultimo = cifrado.slice(-1);
    const adulterado = cifrado.slice(0, -1) + (ultimo === 'a' ? 'b' : 'a');

    // O GCM valida a tag de autenticacao: em vez de devolver lixo, lanca erro.
    expect(() => decrypt(adulterado)).toThrow();
  });

  test('formato invalido e rejeitado', () => {
    expect(() => decrypt('enc:v1:apenas-uma-parte')).toThrow(/inválido/i);
    expect(() => decrypt('enc:v1:aa:bb:cc')).toThrow(/inválido/i);
  });

  test('valores nao textuais atravessam sem alteracao', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt('')).toBe('');
    expect(decrypt(null)).toBeNull();
    expect(decrypt(undefined)).toBeUndefined();
  });

  describe('sem ENCRYPTION_KEY configurada', () => {
    let semChave;
    beforeAll(() => {
      // resetModules descarta o cache do require para que env.js releia
      // process.env — e assim possamos simular a variavel ausente.
      jest.resetModules();
      const original = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      semChave = require('../src/services/crypto.service');
      process.env.ENCRYPTION_KEY = original;
    });

    test('modo degradado: grava em texto puro em vez de quebrar', () => {
      expect(semChave.isEncryptionEnabled()).toBe(false);
      expect(semChave.encrypt('segredo')).toBe('segredo');
    });

    test('mas recusa decifrar um valor cifrado, em vez de devolver lixo', () => {
      expect(() => semChave.decrypt('enc:v1:aa:bb:cc')).toThrow(/ENCRYPTION_KEY/);
    });
  });

  describe('com ENCRYPTION_KEY malformada', () => {
    test('chave fora do formato hex de 64 caracteres e tratada como ausente', () => {
      jest.resetModules();
      const original = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = 'chave-curta-demais';
      const mod = require('../src/services/crypto.service');
      expect(mod.isEncryptionEnabled()).toBe(false);
      process.env.ENCRYPTION_KEY = original;
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. NORMALIZACAO DE E-MAIL
// ═══════════════════════════════════════════════════════════════
describe('utils/email — normalizacao', () => {
  test('converte para minusculas e remove espacos das pontas', () => {
    expect(normalizeEmail('  Fulano@Gmail.COM  ')).toBe('fulano@gmail.com');
  });

  test('e-mails que antes nao casavam agora sao equivalentes', () => {
    // Este era o bug real: convidar "Fulano@Gmail.com" e logar como
    // "fulano@gmail.com" nunca casava, porque o SQL compara texto exato.
    expect(normalizeEmail('Fulano@Gmail.com')).toBe(normalizeEmail('fulano@gmail.com'));
  });

  test('valores invalidos viram null', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });

  test('validacao de formato aceita enderecos plausiveis', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('  Eduardo.Fritz@Catolica.SC  ')).toBe(true);
  });

  test('validacao de formato recusa enderecos claramente errados', () => {
    expect(isValidEmail('sem-arroba')).toBe(false);
    expect(isValidEmail('sem@dominio')).toBe(false);
    expect(isValidEmail('com espaco@dominio.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. AUTORIZACAO DE CASAS COMPARTILHADAS
// ═══════════════════════════════════════════════════════════════
describe('sharing.service — resolveHomeAccess', () => {
  const DONO = 'dono@ihome.com';
  const CONVIDADO = 'convidado@ihome.com';

  test('so existem dois niveis de permissao', () => {
    expect(PERMISSOES_VALIDAS).toEqual(['view', 'control']);
  });

  test('na propria casa o acesso e liberado sem consultar o banco', () => {
    return resolveHomeAccess(DONO, undefined, 'control').then((r) => {
      expect(r.allowed).toBe(true);
      expect(r.homeOwnerEmail).toBe(DONO);
      expect(mockQuery).not.toHaveBeenCalled(); // atalho: nem toca no banco
    });
  });

  test('owner_email igual ao proprio e tratado como casa propria', async () => {
    const r = await resolveHomeAccess(DONO, DONO, 'control');
    expect(r.allowed).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('e-mails com maiusculas sao normalizados antes da comparacao', async () => {
    const r = await resolveHomeAccess('Dono@iHome.com', 'DONO@IHOME.COM', 'control');
    expect(r.allowed).toBe(true);
    expect(r.homeOwnerEmail).toBe(DONO);
  });

  // ── A CORRECAO DE SEGURANCA ──
  test('a consulta exige status = accepted', async () => {
    await resolveHomeAccess(CONVIDADO, DONO, 'control');
    const [sql, params] = mockQuery.mock.calls[0];

    // Sem este filtro, um convite apenas ENVIADO ja daria controle da casa.
    expect(sql).toMatch(/status\s*=\s*'accepted'/);
    expect(params).toEqual([DONO, CONVIDADO]);
  });

  test('convite pendente (nenhuma linha aceita) nao concede acesso', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await resolveHomeAccess(CONVIDADO, DONO, 'control');
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.homeOwnerEmail).toBe(DONO); // ainda assim sabemos a casa, para auditar
  });

  test('permissao control satisfaz exigencia de control', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'control' }], rowCount: 1 });
    const r = await resolveHomeAccess(CONVIDADO, DONO, 'control');
    expect(r.allowed).toBe(true);
    expect(r.permission).toBe('control');
  });

  test('permissao view NAO satisfaz exigencia de control', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'view' }], rowCount: 1 });
    const r = await resolveHomeAccess(CONVIDADO, DONO, 'control');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/visualiza/i);
  });

  test('permissao view satisfaz exigencia de view (leitura nao altera nada)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'view' }], rowCount: 1 });
    const r = await resolveHomeAccess(CONVIDADO, DONO, 'view');
    expect(r.allowed).toBe(true);
  });

  test('permissao control tambem satisfaz exigencia de view', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'control' }], rowCount: 1 });
    const r = await resolveHomeAccess(CONVIDADO, DONO, 'view');
    expect(r.allowed).toBe(true);
  });
});
