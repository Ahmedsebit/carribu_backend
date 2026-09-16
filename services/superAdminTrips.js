const { Trip, Route } = require('../models');

const endSchoolTrip = async (schoolId, tripId) => {
  const trip = await Trip.findOne({
    where: { id: tripId },
    include: [{
      model: Route,
      as: 'route',
      where: { schoolId },
      attributes: ['id'],
      required: true,
    }],
  });

  if (!trip) {
    const error = new Error('Trip not found for this school.');
    error.status = 404;
    throw error;
  }
  if (trip.status !== 'in_progress') {
    const error = new Error('Only an in-progress trip can be ended.');
    error.status = 400;
    throw error;
  }

  await trip.update({ status: 'completed', endedAt: new Date() });
  return trip;
};

module.exports = { endSchoolTrip };
