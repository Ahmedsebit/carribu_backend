const { Vehicle, School, Route, User } = require('../models');
const { Op } = require('sequelize');
exports.getAll = async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.search) where[Op.or] = [{ plateNumber: { [Op.iLike]: `%${req.query.search}%` } }, { make: { [Op.iLike]: `%${req.query.search}%` } }, { model: { [Op.iLike]: `%${req.query.search}%` } }];
    const vehicles = await Vehicle.findAll({ where, include: [{ model: School, as: 'school', attributes: ['id','name'] }, { model: Route, as: 'routes', attributes: ['id','name'], include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName'] }] }], order: [['created_at','DESC']] });
    res.json({ vehicles, total: vehicles.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId }, include: [{ model: School, as: 'school', attributes: ['id','name'] }, { model: Route, as: 'routes', include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] }] }] });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ vehicle });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const plateNumber = String(req.body.plateNumber || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!plateNumber) return res.status(400).json({ error: 'Plate number is required.' });
    const existing = await Vehicle.findOne({ where: { plateNumber: { [Op.iLike]: plateNumber } } });
    if (existing) return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    const vehicle = await Vehicle.create({ ...req.body, plateNumber, schoolId: req.user.schoolId });
    res.status(201).json({ message: 'Vehicle created.', vehicle });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.update = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    const updates = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updates, 'plateNumber')) {
      updates.plateNumber = String(updates.plateNumber || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!updates.plateNumber) return res.status(400).json({ error: 'Plate number is required.' });
      const existing = await Vehicle.findOne({ where: { plateNumber: { [Op.iLike]: updates.plateNumber }, id: { [Op.ne]: vehicle.id } } });
      if (existing) return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    }
    await vehicle.update(updates); res.json({ message: 'Vehicle updated.', vehicle });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.delete = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    await vehicle.update({ status: 'retired' }); res.json({ message: 'Vehicle retired.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getStats = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const [active, maintenance, retired, total] = await Promise.all([
      Vehicle.count({ where: { schoolId, status: 'active' } }), Vehicle.count({ where: { schoolId, status: 'maintenance' } }),
      Vehicle.count({ where: { schoolId, status: 'retired' } }), Vehicle.count({ where: { schoolId } }),
    ]);
    res.json({ stats: { total, active, maintenance, retired } });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
