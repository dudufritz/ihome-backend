/**
 * routes/index.js — Registro central das rotas.
 *
 * Cada arquivo exporta um Router do Express com o próprio conjunto de rotas.
 * Aqui todos são montados na raiz, mantendo os caminhos públicos exatamente
 * como eram antes da modularização — o frontend não precisou mudar nada.
 */
const express = require('express');

const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const credentialsRoutes = require('./credentials.routes');
const myDevicesRoutes = require('./myDevices.routes');
const devicesRoutes = require('./devices.routes');
const sharesRoutes = require('./shares.routes');
const alertsRoutes = require('./alerts.routes');
const pushRoutes = require('./push.routes');
const schedulesRoutes = require('./schedules.routes');
const auditRoutes = require('./audit.routes');
const aiRoutes = require('./ai.routes');

const router = express.Router();

router.use(healthRoutes);      // /            /health           /vapid-public-key
router.use(authRoutes);        // /auth/login  /auth/register    /auth/refresh ...
router.use(credentialsRoutes); // /tuya-credentials
router.use(myDevicesRoutes);   // /my-devices  /discover-devices
router.use(devicesRoutes);     // /devices     /devices/:id/command  /devices/:id/status
router.use(sharesRoutes);      // /shares      /shared-with-me
router.use(alertsRoutes);      // /alerts
router.use(pushRoutes);        // /push-subscribe
router.use(schedulesRoutes);   // /schedules
router.use(auditRoutes);       // /audit-log   /audit-log/actors
router.use(aiRoutes);          // /ai-command

module.exports = router;
