/**
 * Test app - Express app without Socket.IO for unit tests
 * Avoids connection/listener issues in test environment
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mock io on app for controllers that use req.app.get('io')
app.set('io', { to: () => ({ emit: () => {} }), emit: () => {} });

app.use('/api/auth', require('../routes/auth'));
app.use('/api/schools', require('../routes/schools'));
app.use('/api/vehicles', require('../routes/vehicles'));
app.use('/api/students', require('../routes/students'));
app.use('/api/routes', require('../routes/routes'));
app.use('/api/trips', require('../routes/trips'));
app.use('/api/messages', require('../routes/messages'));
app.use('/api/location', require('../routes/location'));
app.use('/api/driver', require('../routes/driver'));
app.use('/api/parents', require('../routes/parents'));
app.use('/api/drivers', require('../routes/drivers'));
app.use('/api/import', require('../routes/import'));

app.get('/api/health', (req, res) => res.json({ status: 'OK' }));
app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ error: err.message }); });

module.exports = app;
