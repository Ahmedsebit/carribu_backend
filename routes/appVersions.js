const router = require('express').Router();
const { AppVersion } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: App Versions
 *   description: App version and download link management
 */

/**
 * @swagger
 * /api/app-versions/latest/{appName}:
 *   get:
 *     summary: Get the latest version info and download link for an app
 *     tags: [App Versions]
 *     parameters:
 *       - in: path
 *         name: appName
 *         required: true
 *         schema:
 *           type: string
 *           enum: [parent, driver]
 *         description: The app identifier
 *     responses:
 *       200:
 *         description: Latest version info
 */
router.get('/latest/:appName', async (req, res) => {
  try {
    const { appName } = req.params;
    const latest = await AppVersion.findOne({
      where: { appName, isActive: true },
      order: [['createdAt', 'DESC']],
    });
    if (!latest) return res.status(404).json({ error: 'No version found for this app.' });
    res.json({ version: latest.version, downloadUrl: latest.downloadUrl, releaseNotes: latest.releaseNotes, updatedAt: latest.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/app-versions:
 *   get:
 *     summary: List all app versions (admin only)
 *     tags: [App Versions]
 *     responses:
 *       200:
 *         description: List of all app versions
 */
router.get('/', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const versions = await AppVersion.findAll({ order: [['createdAt', 'DESC']] });
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/app-versions:
 *   post:
 *     summary: Create a new app version entry (admin only)
 *     tags: [App Versions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [appName, version, downloadUrl]
 *             properties:
 *               appName:
 *                 type: string
 *                 enum: [parent, driver]
 *               version:
 *                 type: string
 *               downloadUrl:
 *                 type: string
 *               releaseNotes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Version created
 */
router.post('/', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { appName, version, downloadUrl, releaseNotes } = req.body;
    if (!appName || !version || !downloadUrl) {
      return res.status(400).json({ error: 'appName, version, and downloadUrl are required.' });
    }
    const appVersion = await AppVersion.create({ appName, version, downloadUrl, releaseNotes });
    res.status(201).json({ appVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/app-versions/{id}:
 *   put:
 *     summary: Update an app version entry (admin only)
 *     tags: [App Versions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Version updated
 */
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const appVersion = await AppVersion.findByPk(req.params.id);
    if (!appVersion) return res.status(404).json({ error: 'Version not found.' });
    const { version, downloadUrl, releaseNotes, isActive } = req.body;
    await appVersion.update({ version, downloadUrl, releaseNotes, isActive });
    res.json({ appVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/app-versions/{id}:
 *   delete:
 *     summary: Delete an app version entry (admin only)
 *     tags: [App Versions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Version deleted
 */
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const appVersion = await AppVersion.findByPk(req.params.id);
    if (!appVersion) return res.status(404).json({ error: 'Version not found.' });
    await appVersion.destroy();
    res.json({ message: 'Version deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
