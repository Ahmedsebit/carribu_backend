// Adds a 'delayed' value to the trip status enum. A scheduled trip is marked
// 'delayed' once its scheduled start time passes without the driver
// acknowledging (starting) it, but while it is still within the start grace
// window. Once the grace window lapses the trip moves on to 'missed'
// (surfaced to admins as "not started"). This lets the admin dashboard and the
// driver app distinguish "running late but still expected" from "never ran".
//
// Postgres enums require ALTER TYPE ... ADD VALUE; it is idempotent here via
// IF NOT EXISTS. Enum values cannot be dropped, so `down` is a no-op.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_trips_status" ADD VALUE IF NOT EXISTS 'delayed';`
    );
  },

  async down() {
    // Postgres does not support removing a value from an enum type.
  },
};
