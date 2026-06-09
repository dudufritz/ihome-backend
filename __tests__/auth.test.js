const jwt = require('jsonwebtoken');

// Testa a lógica do authMiddleware isoladamente
describe('Auth Middleware - Lógica de Token', () => {
  const SECRET = 'test-secret-key';

  test('token válido HS256 é decodificado corretamente', () => {
    const payload = { sub: 'user-123', email: 'test@email.com' };
    const token = jwt.sign(payload, SECRET, { algorithm: 'HS256' });
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });

    expect(decoded.sub).toBe('user-123');
    expect(decoded.email).toBe('test@email.com');
  });

  test('token expirado lança erro', () => {
    const payload = { sub: 'user-123', email: 'test@email.com' };
    const token = jwt.sign(payload, SECRET, { expiresIn: '0s' });

    expect(() =>
      jwt.verify(token, SECRET, { algorithms: ['HS256'] })
    ).toThrow(/expired/);
  });

  test('token com secret errado lança erro', () => {
    const payload = { sub: 'user-123', email: 'test@email.com' };
    const token = jwt.sign(payload, SECRET, { algorithm: 'HS256' });

    expect(() =>
      jwt.verify(token, 'wrong-secret', { algorithms: ['HS256'] })
    ).toThrow(/invalid/);
  });

  test('token malformado lança erro', () => {
    expect(() =>
      jwt.verify('token.invalido.aqui', SECRET, { algorithms: ['HS256'] })
    ).toThrow();
  });

  test('payload contém campos obrigatórios', () => {
    const payload = { sub: 'user-abc', email: 'user@ihome.com' };
    const token = jwt.sign(payload, SECRET);
    const decoded = jwt.verify(token, SECRET);

    expect(decoded).toHaveProperty('sub');
    expect(decoded).toHaveProperty('email');
    expect(decoded.email).toMatch(/@/);
  });
});
