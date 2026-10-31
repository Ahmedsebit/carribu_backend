module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT driver_id FROM trips WHERE status = 'in_progress' AND driver_id IS NOT NULL GROUP BY driver_id HAVING COUNT(*) > 1)
            OR EXISTS (SELECT vehicle_id FROM trips WHERE status = 'in_progress' AND vehicle_id IS NOT NULL GROUP BY vehicle_id HAVING COUNT(*) > 1)
          THEN RAISE EXCEPTION 'Resolve overlapping active trips for each driver and vehicle before migrating.';
          END IF;
        END $$;
        ALTER TABLE trips ADD COLUMN IF NOT EXISTS plan JSONB;
        ALTER TABLE trip_logs ADD COLUMN IF NOT EXISTS phase VARCHAR(16);
        ALTER TABLE trip_logs ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);
        CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_driver ON trips(driver_id) WHERE status = 'in_progress';
        CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_vehicle ON trips(vehicle_id) WHERE status = 'in_progress';
        CREATE UNIQUE INDEX IF NOT EXISTS trip_logs_idempotency ON trip_logs(trip_id, idempotency_key);
        CREATE UNIQUE INDEX IF NOT EXISTS trip_logs_action_phase ON trip_logs(trip_id, student_id, action, phase);
        CREATE TABLE IF NOT EXISTS notification_outbox (
          id SERIAL PRIMARY KEY,
          event_key VARCHAR(200) NOT NULL UNIQUE,
          school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          event VARCHAR(80) NOT NULL,
          payload JSONB NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          locked_until TIMESTAMPTZ,
          last_error VARCHAR(200),
          provider_results JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS notification_outbox_status_next_attempt_at ON notification_outbox(status, next_attempt_at);
      `, { transaction });
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        DROP TABLE IF EXISTS notification_outbox;
        DROP INDEX IF EXISTS trip_logs_action_phase;
        DROP INDEX IF EXISTS trip_logs_idempotency;
        DROP INDEX IF EXISTS trips_one_active_driver;
        DROP INDEX IF EXISTS trips_one_active_vehicle;
        ALTER TABLE trip_logs DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS phase;
        ALTER TABLE trips DROP COLUMN IF EXISTS plan;
      `, { transaction });
    });
  },
};
