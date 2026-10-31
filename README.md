# Carribu Backend

School transport management API built with Express.js, Sequelize (PostgreSQL), and Socket.IO for real-time tracking.

## Features

- **Multi-role auth** – Admin, Driver, and Parent roles with JWT authentication
- **School management** – Schools, vehicles, students, and routes
- **Trip tracking** – Start/end trips, pickup/drop-off logging
- **Real-time location** – Socket.IO for live driver location updates
- **Messaging** – In-app messaging between drivers and parents
- **Route management** – Assign students to routes with stop ordering

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Framework | Express.js |
| Database | PostgreSQL |
| ORM | Sequelize |
| Auth | JWT (jsonwebtoken + bcryptjs) |
| Real-time | Socket.IO |
| Validation | express-validator |
| Security | Helmet, CORS |

## Prerequisites

- **Node.js** v18+
- **PostgreSQL** v14+
- **npm** v9+

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/Ahmedsebit/carribu_backend.git
cd carribu_backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example env file and update values as needed:

```bash
cp .env.example .env
```

**`.env` variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `NODE_ENV` | Environment (`development` / `production` / `test`) | `development` |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `school_transport` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password | `postgres` |
| `JWT_SECRET` | Secret key for JWT signing | — |
| `JWT_EXPIRES_IN` | Token expiry duration | `7d` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for native Android FCM delivery | — |
| `TRACCAR_ENABLED` | Enable Traccar one-minute location polling and live WebSocket updates | `false` |
| `TRACCAR_URL` | Your hosted Traccar server address (HTTPS, optionally ending in `/api`) | — |
| `TRACCAR_TOKEN` | Traccar account token, stored only in backend deployment secrets | — |
| `TRACKER_WEBHOOK_TOKEN` | Shared secret for Traccar position/event forwarding | — |

Expo push delivery works without Firebase configuration. To enable native
Android notifications, set `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret in the
deployment environment. Never commit the service-account file or JSON value.
The authenticated `PUT /api/auth/push-token` endpoint accepts
`provider: "expo"` (the backward-compatible default) or `provider: "fcm"` and
stores the tokens independently.

### 4. Create the database

```bash
createdb school_transport
```

Or via psql:

```sql
CREATE DATABASE school_transport;
```

### 5. Start the server

```bash
# Development (with hot reload)
npm run dev

# Production
npm start
```

The server runs database migrations automatically on startup (before it begins
listening), so the schema is always brought up to date. See
[Database migrations](#database-migrations) below.

### 6. Seed sample data (optional)

```bash
npm run db:seed
```

## Database migrations

Schema changes are managed with [umzug](https://github.com/sequelize/umzug)
migrations in `migrations/`, tracked in the `sequelize_meta` table.

- **On startup** the server runs all pending migrations before listening.
- **Existing databases** created before migrations existed (via the old
  `sequelize.sync`) are detected automatically and *baselined* — the baseline
  migration is recorded as already applied so your data is never dropped.

### Commands

```bash
npm run db:migrate          # apply all pending migrations
npm run db:migrate:status   # show executed + pending migrations
npm run db:migrate:pending  # list pending migrations
npm run db:migrate:undo     # revert the last migration
```

### Adding a migration

Create `migrations/000N-description.js` exporting `up`/`down`:

```js
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('users', 'nickname', {
      type: require('sequelize').DataTypes.STRING, allowNull: true,
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('users', 'nickname');
  },
};
```

Migrations run in filename order, so keep the numeric prefix increasing.

> **Note:** `migrations/sql/0001-baseline.sql` is the frozen initial schema,
> generated from the models via `node scripts/gen-baseline.js`. Don't edit it by
> hand — subsequent changes belong in new migration files.

### Legacy `DB_SYNC` (deprecated)

Setting `DB_SYNC` (`alter`/`safe`/`force`) makes startup fall back to
`sequelize.sync` and **skips migrations**. This is only for local
experimentation; leave it unset so migrations manage the schema.

## Authoritative trip workflow

Trips freeze their ordered student roster, guardian contact details, school
destination and pickup/drop-off coordinates **when started**, not when scheduled.
Set the school's destination as the **last outbound route waypoint**. Starting
requires an active driver/vehicle, an active school roster, valid stop coordinates,
and sufficient vehicle capacity. Driver and vehicle assignments are exclusive
across active trips; a student cannot travel on two active trips or repeat a
completed journey of the same type on the same scheduled date.

Morning trips resolve home pickups before school drop-offs. Afternoon trips
require explicit school boarding or absence for every child before starting
home drop-offs, in reversed stop order. A valid guardian drop-off location is
used when configured; otherwise the pickup location is used. Arrival records
do not advance the stop until boarding, absence or drop-off resolves it.
Every role, including super admin, must resolve all students as dropped off or
absent before completion. Active routes cannot be edited or deactivated.

Driver and admin responses expose server-owned `phase`, `currentStop`, `nextStop`,
`pickupList` and `canEnd`. Use these rather than calculating a separate itinerary.
Student actions accept `phase: "pickup" | "dropoff"` and an `idempotencyKey`
(maximum 100 characters), conventionally
`<tripId>:<studentId>:<phase>:<action>`. Repeated starts, completions and matching
actions are idempotent; reusing a key for another operation returns HTTP 409.

Migration `0016` adds snapshots, log deduplication, partial unique assignment
indexes and the transactional notification outbox. Leave `DB_SYNC` unset.
The migration refuses overlapping active assignments without changing data:
resolve those trips before deployment. Reversing this migration deletes the
new snapshots/outbox and idempotency metadata; back up the database first.
Pre-upgrade history cannot recover an immutable past roster. Existing active
afternoon trips require explicit boarding reconciliation; a missing legacy
snapshot is captured on the next workflow action or accepted GPS update.

### Parent notifications and diagnostics

Trip start, arrival, boarding, absence, drop-off and completion events save their
in-app messages and outbox records in the same transaction as the trip action.
Fresh authoritative GPS fixes also queue phase-aware ETA/near-stop warnings.
Proximity and ETA are suppressed during afternoon boarding, for fixes older
than 120 seconds, and for out-of-order positions. GPS allows at most 30 seconds
of future clock skew. ETAs are straight-line estimates, not road-routing promises.
Linked vehicles retain Traccar-only tracking with no phone fallback.

The worker runs automatically after migrations, claims recoverable five-minute
leases, retries failed submissions with backoff, and checks Expo receipts without
resending accepted tickets. Stable event IDs allow clients to deduplicate
at-least-once realtime delivery. Provider retries cannot guarantee exactly-once
delivery to a handset. Late proximity alerts and revoked guardian/school access
are cancelled; guardian reassignment takes effect in the next trip snapshot.

`GET /api/trips/:id/notifications` is restricted to that school's admin or
coordinator. It returns up to 200 recent event diagnostics, not parent message
payloads, credentials or device tokens. `accepted` means provider acceptance,
**not handset delivery or parent read**. `pending_receipt`, `retrying`,
`unregistered`, `failed` and `cancelled` distinguish delivery outcomes. Push
requires a registered Expo/FCM token; native FCM also requires the backend
Firebase configuration described above. Device permissions and real-device
delivery still need verification in the deployment environment.

### Workflow regression checks

The integration setup **recreates the database schema**. Use only a disposable
local database named `carribu_workflow_*`; the new workflow/outbox/migration
suites refuse other database names or a host other than `127.0.0.1`.
Create that database and set its local credentials before running:

```powershell
$env:DB_NAME='carribu_workflow_local'
$env:DB_HOST='127.0.0.1'
$env:DB_PORT='5432'
$env:DB_USER='postgres'
$env:DB_PASSWORD='<local-password>'
$env:NODE_ENV='test'
$env:JWT_SECRET='workflow-test-only'
npm test -- --runTestsByPath tests\tripPlan.test.js tests\tripWorkflow.test.js tests\tripWorkflowMigration.test.js tests\notificationOutbox.test.js tests\outboxPush.test.js
```

Keep database suites sequential (`--runInBand`, already set by `npm test`).
Never point these tests at a deployed database or a database containing real data.

## API Documentation (Swagger)

Interactive API documentation is available via Swagger UI:

```
http://localhost:5000/api/docs
```

The raw OpenAPI 3.0 JSON spec is available at:

```
http://localhost:5000/api/docs.json
```

Use the **Authorize** button in Swagger UI to enter your JWT token (`Bearer <token>`) and test authenticated endpoints directly from the browser.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api` | API info |
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login |
| * | `/api/schools` | School CRUD |
| * | `/api/vehicles` | Vehicle CRUD |
| GET | `/api/vehicles/:id/location` | Latest authoritative location for the vehicle's active trip (school admin/coordinator only) |
| * | `/api/students` | Student CRUD |
| * | `/api/routes` | Route CRUD |
| * | `/api/trips` | Trip management |
| * | `/api/messages` | Messaging |
| * | `/api/location` | Location updates |
| * | `/api/driver` | Driver-specific actions |
| * | `/api/drivers` | Driver management |
| * | `/api/parents` | Parent-specific actions |
| POST | `/tracker/position` | Receive a Traccar JSON position |
| POST | `/tracker/event` | Receive a Traccar JSON event |

## Traccar GPS integration

The admin vehicle details page reads `GET /api/vehicles/:id/location` every
10 seconds. This school-scoped endpoint returns the active trip, `locationSource`
(`traccar` or `phone`), and its latest location with GPS timestamp. It returns
`trip: null, location: null` outside active trips. Linked vehicles never fall
back to phone positions. If no Traccar trip point exists, the endpoint can
return the linked device's last-known snapshot, including one predating the
trip. It retains the original `recordedAt`, sets `isLastKnown: true`, and marks
`predatesTrip` when applicable. Admin vehicle details, Trips > Live, and active
trip details show these snapshots with an explicit reference-only warning.
`GET /api/trips/:id/details` uses the same shared location lookup and returns
the same snapshot metadata in `trip.location`, plus `trip.locationSource`.
This keeps the trip-details API consistent with the Live modal. Completed-trip
details use only that trip's recorded history, never a current vehicle snapshot.

Migration **0015-add-vehicle-tracker-positions** adds one durable snapshot per
vehicle in `vehicle_tracker_positions`, separate from `bus_locations`.
Snapshots are refreshed only for linked active vehicles with an active trip.
Older reports cannot overwrite a newer fix for the same tracker. Assignment
changes are rechecked under a vehicle row lock; snapshot reads also require
the current tracker identifier. No new GPS time is fabricated when a position
timestamp is missing or invalid. Unlinking or ending a trip hides the snapshot.
Pre-trip snapshots do not enter trip history, Socket.IO location broadcasts,
ETA calculations, or proximity notifications. Parent tracking is unchanged.
Leave `DB_SYNC` unset so startup applies migration 0015 (and earlier migrations).

### Traccar-managed hosting (recommended)

Data flows from the GPS tracker to hosted Traccar, then to this backend, and
finally to the apps through the existing authenticated APIs and Socket.IO.
Apps do not need Traccar credentials or direct access to Traccar.

1. Create a token in your hosted Traccar account. Use an account with access
   only to the devices this backend should consume.
2. Set `TRACCAR_ENABLED=true`, `TRACCAR_URL` to your tracking server address,
   and `TRACCAR_TOKEN` to the token in backend deployment secrets, then restart.
   Do not use `https://www.traccar.org` as the server URL.
3. Map each device's Traccar `uniqueId` (normally the IMEI) to its Carribu
   vehicle's `trackerUniqueId`, as shown below.

The backend exchanges the token at `GET /api/session?token=...` for a session
cookie. It fetches `/api/devices`, connects to `/api/socket` using that cookie,
and loads `/api/positions` before processing queued live messages. Each
reconnection creates a new session and reloads devices/latest positions.
While connected, a backend job refreshes `/api/devices` and `/api/positions`
every **60 seconds**, using the same authenticated session and ingestion path.
Polling and live messages are processed in order; a slow poll is never
overlapped by another poll. Shutdown cancels the timer and pending requests.
Connections retry with exponential backoff (1 to 30 seconds); heartbeat checks
detect dead sockets. Authentication/connection failures are logged without
logging tokens or cookies. Bad configuration prevents backend startup.

This also works with your self-hosted Traccar instance: set `TRACCAR_ENABLED=true`,
`TRACCAR_URL` to its public HTTPS address, and `TRACCAR_TOKEN` to an account
token from that instance, then redeploy the backend. The startup log
`Traccar location polling enabled (every 60 seconds).` confirms the job started.
Each cycle logs `Traccar location poll started` and `Traccar location poll completed`
with counts of devices, returned positions, stored/duplicate/ignored/rejected
positions, inaccessible devices, and ignored reasons (such as `no_active_trip`).
No coordinates, tokens, or session cookies are included in these poll summaries.
Slow-cycle skips and poll failures are also logged. If polling is disabled,
startup explicitly logs `Traccar location polling disabled`.
These are outgoing requests, so they do not appear in Express's incoming
HTTP access logs.
Fetching stored positions does not command the physical tracker to obtain
a new GPS fix; an offline tracker may still return an old position. Existing
active-trip and stale-position checks still apply.

No `FORWARD_*`, `EVENT_FORWARD_*`, Railway Traccar instance, or webhook secret
is needed for this mode. Keep `TRACCAR_ENABLED=false` on additional backend
replicas: run one ingestion connection per database. Existing database
deduplication handles repeated position/event IDs.

REST initialization restores **latest positions**, not complete position or
event history missed while disconnected. Events arrive live; historical
backfill is not implemented. Positions older than the active trip's start
are excluded from trip history, but retained separately for the admin's
clearly labelled last-known location display during active trips.

See the official [API overview](https://www.traccar.org/traccar-api/) and
[API reference](https://www.traccar.org/api-reference/).

### Optional self-hosted forwarding

Existing webhooks remain available for self-hosted Traccar. The endpoints
require this header:

```http
Authorization: Bearer <TRACKER_WEBHOOK_TOKEN>
```

Set a long random `TRACKER_WEBHOOK_TOKEN` in the backend Railway service. Set
the same value on the Traccar service through `FORWARD_HEADER` and
`EVENT_FORWARD_HEADER`.

### Vehicle mapping and app behavior

For either connection mode, a **super admin** assigns the tracker IMEI to its
Carribu vehicle before expecting positions. In the super-admin app, open
**Schools > school details > Vehicles** and choose **Link tracker** or
**Change tracker**. School admins can view assignments but cannot change them.

```http
PUT /api/super-admin/schools/{schoolId}/vehicles/{vehicleId}/tracker
Authorization: Bearer <admin JWT>
Content-Type: application/json

{"trackerUniqueId":"123456789012345"}
```

The example requires a super-admin JWT. Send `{"trackerUniqueId":null}` to
unlink. Identifiers are trimmed and limited to 128 characters; one tracker
cannot be assigned to multiple vehicles. The vehicle must belong to the
specified school. The school-admin vehicle create/update endpoints reject
`trackerUniqueId` with HTTP 403, even when clearing it. Other vehicle edits
preserve the existing tracker assignment.

Positions are attached to the mapped vehicle's current `in_progress` trip and
feed the existing live map, ETA, proximity notifications, and Socket.IO
updates. Unknown devices, invalid fixes, and positions received with no active
trip are acknowledged but ignored so Traccar does not retry them indefinitely.
Tracker alarms and status events are retained in `tracker_events`.

### Authoritative trip location source

During an active trip, a vehicle with a linked tracker uses **Traccar only**.
Phone GPS cannot overwrite or supplement its live map, ETA, or active-trip
history, even if the device is offline or has not produced a fix yet.
Vehicles without a tracker continue to use their assigned driver's phone.
Completed trips keep their originally recorded history.

Both `POST /api/location/update` and the `driver-location` socket event
enforce this policy server-side. Linked vehicles reject phone updates with
HTTP/status `409` and code `TRACCAR_LOCATION_REQUIRED`; sockets return this
in the acknowledgement or emit `location-error` for older clients.
Socket phone updates for unlinked vehicles use the same validated persistence
and broadcast path as REST. A caller cannot override the source in a payload.

Driver active-trip responses include `locationSource` (`traccar` or `phone`)
and the vehicle's `trackerUniqueId`. Updated driver apps stop phone location
collection for linked vehicles and do not request GPS permissions for them.
Stored locations, live map responses, and `location-update` events include
`source`. Active-trip queries filter by that source, rather than showing an
old phone position while waiting for device data.

**Deployment:** migration `0014-add-location-source` adds `bus_locations.source`
and labels existing positions with Traccar IDs as `traccar`. Remove
`DB_SYNC=alter` (leave `DB_SYNC` unset) so normal startup migrations run and
backfill existing data. The migration does not remove historical locations.

## Real-time (Socket.IO)

Connect with a valid JWT token:

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:5000', {
  auth: { token: 'your-jwt-token' }
});
```

### Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `join-trip` | Client → Server | Driver joins a trip room |
| `track-trip` | Client → Server | Parent subscribes to trip updates |
| `driver-location` | Client → Server | Driver sends GPS coordinates |
| `location-update` | Server → Client | Broadcast location to trip watchers |
| `chat-message` | Client → Server | Send a chat message |
| `new-message` | Server → Client | Receive a chat message |

## Testing

Tests use **Jest** and **Supertest** with a real PostgreSQL database (tables are force-synced per test suite).

### Run all tests

```bash
npm test
```

### Run specific test suites

```bash
npm run test:auth        # Authentication tests
npm run test:resources   # Schools, vehicles, students, routes
npm run test:trips       # Trip management tests
npm run test:messages    # Messaging tests
npm run test:e2e         # End-to-end workflow tests
npm run test:workflow    # Full workflow test
npm run test:socket      # Socket.IO tests
```

### Test database setup

Tests use the same database configured in `.env`. The test setup (`tests/setup.js`) will:
1. Connect to the database
2. Force-sync all tables (drops and recreates)
3. Seed test data (school, users, vehicles, students, routes)

> ⚠️ **Warning:** Tests will drop all tables. Use a separate database for testing if needed:
> ```bash
> createdb school_transport_test
> DB_NAME=school_transport_test npm test
> ```

## Project Structure

```
carribu_backend/
├── config/
│   └── database.js        # Sequelize connection config
├── controllers/           # Route handlers (business logic)
├── middleware/
│   └── auth.js            # JWT authentication middleware
├── models/                # Sequelize models
│   ├── index.js           # Model associations
│   ├── User.js            # Admin, Driver, Parent
│   ├── School.js
│   ├── Vehicle.js
│   ├── Student.js
│   ├── Route.js
│   ├── RouteStudent.js    # Route ↔ Student junction
│   ├── Trip.js
│   ├── TripLog.js         # Pickup/drop-off events
│   ├── Message.js
│   └── BusLocation.js     # Location history
├── routes/                # Express route definitions
├── seeders/
│   └── seed.js            # Sample data seeder
├── tests/
│   ├── setup.js           # Test DB setup & teardown
│   ├── testApp.js         # Test app instance
│   ├── auth.test.js
│   ├── resources.test.js
│   ├── trips.test.js
│   ├── messages.test.js
│   └── e2e/               # End-to-end tests
├── utils/                 # Shared utilities
├── socket.js              # Socket.IO setup & events
├── server.js              # App entry point
├── jest.config.js
├── package.json
└── .env.example
```

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full CRUD on schools, vehicles, routes, students, drivers |
| **Driver** | Start/end trips, send location updates, view assigned routes |
| **Parent** | Track trips, view student info, message drivers |

## License

ISC