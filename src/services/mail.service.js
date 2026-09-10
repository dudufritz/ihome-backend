/**
 * services/mail.service.js — Envio do convite de compartilhamento.
 *
 * O convite é um e-mail com dois links (aceitar/recusar) contendo um token
 * aleatório. Clicar no link é o que prova que a pessoa tem acesso à caixa
 * de entrada daquele endereço — é a autenticação do convite.
 */
const nodemailer = require('nodemailer');
const { env } = require('../config/env');

/**
 * Transporte SMTP do Gmail.
 * family:4 força IPv4 porque alguns provedores de hospedagem anunciam IPv6
 * sem rota funcional, e a conexão fica pendurada até dar timeout.
 */
const mailTransport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // porta 587 usa STARTTLS: começa em claro e sobe para TLS
  family: 4,
  auth: {
    user: env.gmailUser,
    pass: env.gmailAppPassword, // senha de app do Gmail, não a senha da conta
  },
});

/** Monta o HTML do e-mail. Estilos são inline porque clientes de e-mail ignoram <style>. */
function buildInviteHtml({ ownerEmail, permission, acceptUrl, declineUrl }) {
  const rotulo = permission === 'view' ? 'visualização' : 'controle';
  return `
  <!DOCTYPE html>
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#0b0f19;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f19;padding:40px 0">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111a26;border-radius:16px;overflow:hidden;max-width:560px;width:100%">
          <tr><td style="background:linear-gradient(135deg,#0097b2,#22d3ee);padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700">iHome</h1>
            <p style="color:#cffafe;margin:8px 0 0;font-size:14px">Automação Residencial</p>
          </td></tr>
          <tr><td style="padding:32px">
            <h2 style="color:#f1f5f9;margin:0 0 16px;font-size:20px">Você recebeu um convite</h2>
            <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
              <strong style="color:#e2e8f0">${ownerEmail}</strong> está convidando você para acessar
              os dispositivos da casa dele(a) com permissão de
              <strong style="color:#22d3ee">${rotulo}</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="48%" style="padding-right:8px">
                <a href="${acceptUrl}" style="display:block;background:#059669;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:15px;font-weight:700">Aceitar convite</a>
              </td>
              <td width="48%" style="padding-left:8px">
                <a href="${declineUrl}" style="display:block;background:#b91c1c;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:15px;font-weight:700">Recusar convite</a>
              </td>
            </tr></table>
            <p style="color:#475569;margin:28px 0 0;font-size:12px;text-align:center">
              Se você não esperava este convite, pode ignorar este e-mail com segurança.
            </p>
          </td></tr>
          <tr><td style="background:#0b0f19;padding:20px;text-align:center">
            <p style="color:#334155;margin:0;font-size:12px">iHome Automação Residencial</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/**
 * Envia o convite. Quem chama deve tratar a exceção: o convite já foi gravado
 * no banco antes do envio, então uma falha de e-mail não deve desfazer nada —
 * apenas ser reportada.
 */
async function sendInviteEmail({ ownerEmail, guestEmail, permission, token }) {
  const acceptUrl = `${env.backendUrl}/shares/accept/${token}`;
  const declineUrl = `${env.backendUrl}/shares/decline/${token}`;

  await mailTransport.sendMail({
    from: `"iHome" <${env.gmailUser}>`,
    to: guestEmail,
    subject: `${ownerEmail} convidou você para a casa dele(a) no iHome`,
    html: buildInviteHtml({ ownerEmail, permission, acceptUrl, declineUrl }),
  });
}

/** Casca visual comum a todos os e-mails transacionais do iHome. */
function layout(titulo, corpo) {
  return `
  <!DOCTYPE html>
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#0b0f19;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f19;padding:40px 0">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111a26;border-radius:16px;overflow:hidden;max-width:560px;width:100%">
          <tr><td style="background:linear-gradient(135deg,#0097b2,#22d3ee);padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700">iHome</h1>
            <p style="color:#cffafe;margin:8px 0 0;font-size:14px">Automação Residencial</p>
          </td></tr>
          <tr><td style="padding:32px">
            <h2 style="color:#f1f5f9;margin:0 0 16px;font-size:20px">${titulo}</h2>
            ${corpo}
          </td></tr>
          <tr><td style="background:#0b0f19;padding:20px;text-align:center">
            <p style="color:#334155;margin:0;font-size:12px">iHome Automação Residencial</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/** Botão de ação padrão dos e-mails. */
function botao(url, texto) {
  return `<a href="${url}" style="display:block;background:#0097b2;color:#fff;text-decoration:none;text-align:center;padding:15px;border-radius:10px;font-size:15px;font-weight:700;margin:8px 0 24px">${texto}</a>`;
}

/**
 * E-mail de redefinição de senha.
 *
 * O link aponta para o FRONTEND, não para a API: quem precisa coletar a
 * nova senha é a interface. O backend só entra depois, quando o formulário
 * envia token e senha para POST /auth/reset-password.
 */
async function sendPasswordResetEmail({ email, token }) {
  const url = `${env.frontendUrl}/redefinir-senha?token=${token}`;
  const validade = Math.round(env.resetTokenMinutes / 60) || 1;

  await mailTransport.sendMail({
    from: `"iHome" <${env.gmailUser}>`,
    to: email,
    subject: 'Redefinição de senha — iHome',
    html: layout('Redefinir sua senha', `
      <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
        Recebemos um pedido para redefinir a senha da sua conta. Clique no botão
        abaixo para escolher uma nova senha.
      </p>
      ${botao(url, 'Redefinir senha')}
      <p style="color:#64748b;margin:0 0 8px;font-size:13px">
        Este link vale por ${validade} hora${validade > 1 ? 's' : ''} e só pode ser usado uma vez.
      </p>
      <p style="color:#475569;margin:0;font-size:12px">
        Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.
      </p>
    `),
  });
}

/**
 * E-mail de confirmação de endereço.
 * Aqui o link aponta para a API, que valida o token e redireciona o
 * navegador de volta ao frontend — não há dado nenhum a coletar do usuário.
 */
async function sendVerificationEmail({ email, token }) {
  const url = `${env.backendUrl}/auth/verify-email/${token}`;

  await mailTransport.sendMail({
    from: `"iHome" <${env.gmailUser}>`,
    to: email,
    subject: 'Confirme seu e-mail — iHome',
    html: layout('Bem-vindo ao iHome', `
      <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
        Sua conta foi criada. Confirme seu endereço de e-mail para garantir que
        você consiga recuperar o acesso caso esqueça a senha.
      </p>
      ${botao(url, 'Confirmar e-mail')}
      <p style="color:#475569;margin:0;font-size:12px">
        Se não foi você quem criou esta conta, ignore este e-mail.
      </p>
    `),
  });
}

module.exports = {
  sendInviteEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  mailTransport,
};
