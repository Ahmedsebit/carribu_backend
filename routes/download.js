const router = require('express').Router();
const { AppVersion } = require('../models');

router.get('/:appName', async (req, res) => {
  try {
    const { appName } = req.params;
    const latest = await AppVersion.findOne({
      where: { appName, isActive: true },
      order: [['createdAt', 'DESC']],
    });

    const defaultUrls = {
      parent: 'https://t3.storageapi.dev/parent-app.apk',
      driver: '',
    };
    const downloadUrl = latest?.downloadUrl || defaultUrls[appName] || '#';
    const version = latest?.version || '1.0.0';
    const releaseNotes = latest?.releaseNotes || '';

    const appDisplayName = appName === 'parent' ? 'Carribu Parent' : 'Carribu Driver';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Download ${appDisplayName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 20px;
      padding: 40px 30px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 20px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
    }
    h1 { font-size: 24px; color: #333; margin-bottom: 8px; }
    .version { color: #888; font-size: 14px; margin-bottom: 20px; }
    .notes { color: #555; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
    .download-btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      text-decoration: none;
      padding: 16px 40px;
      border-radius: 50px;
      font-size: 18px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 15px rgba(102,126,234,0.4);
    }
    .download-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102,126,234,0.6); }
    .instructions {
      margin-top: 24px;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 12px;
      font-size: 13px;
      color: #666;
      line-height: 1.6;
    }
    .instructions strong { color: #333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚌</div>
    <h1>${appDisplayName}</h1>
    <p class="version">Version ${version}</p>
    ${releaseNotes ? `<p class="notes">${releaseNotes}</p>` : ''}
    <a href="${downloadUrl}" class="download-btn">⬇️ Download APK</a>
    <div class="instructions">
      <strong>Installation Steps:</strong><br>
      1. Tap "Download APK" above<br>
      2. Open the downloaded file<br>
      3. Allow "Install from unknown sources" if prompted<br>
      4. Tap "Install"
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Something went wrong. Please try again later.');
  }
});

module.exports = router;
