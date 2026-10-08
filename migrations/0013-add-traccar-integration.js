module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE vehicles
      ADD COLUMN IF NOT EXISTS tracker_unique_id VARCHAR(128);

      CREATE UNIQUE INDEX IF NOT EXISTS vehicles_tracker_unique_id_unique
      ON vehicles (tracker_unique_id)
      WHERE tracker_unique_id IS NOT NULL;

      ALTER TABLE bus_locations
      ADD COLUMN IF NOT EXISTS tracker_position_id BIGINT;

      CREATE UNIQUE INDEX IF NOT EXISTS bus_locations_tracker_position_id_unique
      ON bus_locations (tracker_position_id)
      WHERE tracker_position_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS tracker_events (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
        tracker_event_id BIGINT,
        event_type VARCHAR(100) NOT NULL,
        event_time TIMESTAMP WITH TIME ZONE NOT NULL,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS tracker_events_tracker_event_id_unique
      ON tracker_events (tracker_event_id)
      WHERE tracker_event_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS tracker_events_vehicle_event_time
      ON tracker_events (vehicle_id, event_time DESC);
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS tracker_events;
      DROP INDEX IF EXISTS bus_locations_tracker_position_id_unique;
      ALTER TABLE bus_locations DROP COLUMN IF EXISTS tracker_position_id;
      DROP INDEX IF EXISTS vehicles_tracker_unique_id_unique;
      ALTER TABLE vehicles DROP COLUMN IF EXISTS tracker_unique_id;
    `);
  },
};
