const { sequelize, Vehicle, VehicleTrackerPosition } = require('../models');

async function rememberTrackerPosition(values) {
  return sequelize.transaction(async transaction => {
    const vehicle = await Vehicle.findOne({
      where: { id: values.vehicleId, trackerUniqueId: values.trackerUniqueId, status: 'active' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!vehicle) return false;

    const previous = await VehicleTrackerPosition.findByPk(vehicle.id, { transaction });
    if (previous?.trackerUniqueId === values.trackerUniqueId
      && new Date(previous.recordedAt) >= values.recordedAt) {
      return true;
    }
    await VehicleTrackerPosition.upsert(values, { transaction });
    return true;
  });
}

module.exports = { rememberTrackerPosition };
