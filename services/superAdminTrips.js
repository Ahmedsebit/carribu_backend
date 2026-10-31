const { completeTrip } = require('./tripWorkflow');

const endSchoolTrip = async (schoolId, tripId) => {
  const { trip } = await completeTrip(tripId, { schoolId, role: 'super_admin' });
  return trip;
};

module.exports = { endSchoolTrip };
