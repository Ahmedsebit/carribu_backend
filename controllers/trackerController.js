const { ingestPosition, ingestEvent } = require('../services/trackerIngestion');

exports.position = async (req, res) => {
  try {
    const result = await ingestPosition(req.body || {});
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Traccar position webhook failed:', error);
    res.status(500).json({ error: 'Unable to process tracker position.' });
  }
};

exports.event = async (req, res) => {
  try {
    const result = await ingestEvent(req.body || {}, req.app.get('io'));
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Traccar event webhook failed:', error);
    res.status(500).json({ error: 'Unable to process tracker event.' });
  }
};
