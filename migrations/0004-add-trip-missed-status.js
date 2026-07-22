// Adds a 'missed' value to the trip status enum. A scheduled trip is marked
// 'missed' when its start window (scheduled time + grace) lapses without the
// driver starting it, so the driver app can move on to the next trip and the
// admin dashboard reflects that the trip never ran.
//
// Postgres enums require ALTER TYPE ... ADD VALUE; it is idempotent here via
// IF NOT EXISTS. Enum values cannot be dropped, so `down` is a no-op.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_trips_status" ADD VALUE IF NOT EXISTS 'missed';`
    );
  },

  async down() {
    // Postgres does not support removing a value from an enum type.
  },
};
