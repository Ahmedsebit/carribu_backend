const radians = degrees => degrees * Math.PI / 180;
const distanceInMeters = (lat1, lng1, lat2, lng2) => {
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

module.exports = { distanceInMeters };
