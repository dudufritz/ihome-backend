/**
 * services/crypto.service.js — Criptografia dos segredos Tuya.
 *
 * PROBLEMA QUE RESOLVE
 * O tuya_secret é a senha da conta Tuya do usuário: quem o obtém controla
 * todos os dispositivos daquela casa. Guardá-lo em texto puro significa que
 * um dump do banco, um backup vazado ou um SELECT de alguém com acesso de
 * leitura entrega o controle da casa. Guardamos cifrado.
 *
 * ALGORITMO: AES-256-GCM
 *  - AES-256 → cifra simétrica forte (mesma chave cifra e decifra).
 *  - GCM     → modo "autenticado": além de cifrar, gera uma tag que prova
 *              que o texto cifrado não foi adulterado. Se alguém trocar um
 *              byte no banco, a decifragem falha em vez de devolver lixo.
 *
 * FORMATO ARMAZENADO:  enc:v1:<iv>:<authTag>:<textoCifrado>   (tudo em hex)
 *  - o prefixo "enc:v1:" identifica o formato e já prepara uma futura v2;
 *  - o IV (vetor de inicialização) é aleatório a cada gravação, então o mesmo
 *    segredo cifrado duas vezes gera resultados diferentes — isso impede que
 *    alguém descubra que dois usuários usam a mesma credencial.
 */
const crypto = require('crypto');
const { env } = require('../config/env');

const ALGORITMO = 'aes-256-gcm';
const PREFIXO = 'enc:v1:';
const TAMANHO_IV = 12;   // 12 bytes é o tamanho recomendado para GCM
const TAMANHO_TAG = 16;  // a tag de autenticação do GCM tem 16 bytes

/**
 * Converte a ENCRYPTION_KEY (64 caracteres hex) na chave binária de 32 bytes.
 * Retorna null quando a variável não está configurada — nesse caso o sistema
 * opera em modo degradado, guardando em texto puro e avisando no log.
 */
function obterChave() {
  const bruta = env.encryptionKey;
  if (!bruta) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(bruta)) {
    console.error('❌ ENCRYPTION_KEY inválida: são esperados 64 caracteres hexadecimais (32 bytes).');
    return null;
  }
  return Buffer.from(bruta, 'hex');
}

/** Indica se a criptografia está ativa — útil para o /health e para testes. */
function isEncryptionEnabled() {
  return obterChave() !== null;
}

/**
 * Reconhece um valor já cifrado por esta função.
 * É o que permite conviver com as linhas antigas, gravadas em texto puro,
 * antes desta funcionalidade existir.
 */
function isEncrypted(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIXO);
}

/**
 * Cifra um texto. Se não houver chave configurada, devolve o texto original
 * — o app continua funcionando, apenas sem a proteção extra.
 * @param {string} textoPuro
 * @returns {string} valor pronto para gravar no banco
 */
function encrypt(textoPuro) {
  if (typeof textoPuro !== 'string' || textoPuro.length === 0) return textoPuro;
  const chave = obterChave();
  if (!chave) return textoPuro; // modo degradado

  const iv = crypto.randomBytes(TAMANHO_IV);          // novo IV a cada chamada
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);
  const cifrado = Buffer.concat([cipher.update(textoPuro, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();                     // prova de integridade

  return PREFIXO + [iv.toString('hex'), tag.toString('hex'), cifrado.toString('hex')].join(':');
}

/**
 * Decifra um valor vindo do banco.
 *
 * Três caminhos possíveis, todos intencionais:
 *  1. valor sem o prefixo  → linha antiga em texto puro, devolve como está;
 *  2. valor cifrado e chave presente → decifra normalmente;
 *  3. valor cifrado e chave ausente/errada → lança erro, porque devolver
 *     lixo silenciosamente causaria uma falha confusa lá na frente na Tuya.
 */
function decrypt(valorArmazenado) {
  if (typeof valorArmazenado !== 'string') return valorArmazenado;
  if (!isEncrypted(valorArmazenado)) return valorArmazenado; // caso 1: legado

  const chave = obterChave();
  if (!chave) {
    throw new Error('Segredo cifrado no banco, mas ENCRYPTION_KEY não está configurada no servidor.');
  }

  const partes = valorArmazenado.slice(PREFIXO.length).split(':');
  if (partes.length !== 3) throw new Error('Formato de segredo cifrado inválido.');

  const [ivHex, tagHex, dadosHex] = partes;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== TAMANHO_IV || tag.length !== TAMANHO_TAG) {
    throw new Error('Formato de segredo cifrado inválido.');
  }

  const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(tag); // se a tag não bater, o final() abaixo lança erro
  return Buffer.concat([
    decipher.update(Buffer.from(dadosHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, isEncryptionEnabled };
