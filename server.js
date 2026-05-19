const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();
const { sequelize } = require('./models');
const app = express();
const PORT = process.env.PORT || 5000;
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/schools', require('./routes/schools'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/students', require('./routes/students'));
app.use('/api/routes', require('./routes/routes'));
app.use('/api/trips', require('./routes/trips'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/location', require('./routes/location'));
app.use('/api/driver', require('./routes/driver'));
app.get('/api/health', (req, res) => res.json({ status: 'OK', version: '2.0.0' }));
app.get('/api', (req, res) => res.json({ name: 'School Transport API v2.0.0', apps: { web: 'Admin Dashboard', driverApp: 'Driver Mobile (React Native)', parentApp: 'Parent Mobile (React Native)' } }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });
(async () => {
  try {
    await sequelize.authenticate(); console.log('✅ DB connected.');
    await sequelize.sync({ alter: process.env.NODE_ENV === 'development' }); console.log('✅ DB synced (10 tables).');
    app.listen(PORT, () => { console.log(`🚀 Server: http://localhost:${PORT}`); console.log(`📋 API: http://localhost:${PORT}/api`); });
  } catch (err) { console.error('❌ Start failed:', err); process.exit(1); }
})();
