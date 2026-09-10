/**
 * services/push.service.js — Notificações push (Web Push / VAPID).
 *
 * VAPID é o mecanismo que identifica o servidor perante o serviço de push do
 * navegador (FCM no Chrome, Mozilla AutoPush no Firefox). O par de chaves
 * prova que as notificações vêm mesmo do iHome, e não de um terceiro que
 * tenha obtido a URL de assinatura do usuário.
 */
const webpush = require('web-push');
const { pool } = require('../config/database');
const { env } = require('../config/env');

// Indica se o push está operacional. Sem as chaves, o app funciona
// normalmente — apenas não envia notificações.
let pushReady = false;

try {
  if (env.vapidPublicKey && env.vapidPrivateKey) {
    webpush.setVapidDetails(env.vapidEmail, env.vapidPublicKey, env.vapidPrivateKey);
    pushReady = true;
    console.log('✅ Web Push configurado com VAPID.');
  } else if (!env.isTest) {
    console.warn('⚠️ VAPID keys não encontradas — push notifications desativadas.');
  }
} catch (e) {
  console.error('❌ Erro ao configurar VAPID:', e.message);
}

function isPushReady() {
  return pushReady;
}

/**
 * Envia uma notificação para TODAS as assinaturas de um usuário — ele pode
 * ter o iHome aberto no celular e no desktop ao mesmo tempo.
 *
 * Limpeza automática: quando o serviço de push responde 410 (Gone), aquela
 * assinatura morreu (o usuário desinstalou o app ou limpou os dados do site).
 * Apagamos a linha para não tentar de novo indefinidamente.
 */
async function sendPushToUser(userEmail, title, body) {
  try {
    const subs = await pool.query(
      'SELECT subscription FROM push_subscriptions WHERE user_email = $1',
      [userEmail]
    );

    for (const row of subs.rows) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({ title, body, icon: '/logo192.png' })
        );
      } catch (e) {
        if (e.statusCode === 410) {
          await pool.query(
            "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
            [userEmail, row.subscription.endpoint]
          );
        }
      }
    }
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

module.exports = { sendPushToUser, isPushReady };
