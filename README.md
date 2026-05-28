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

The server will auto-sync tables on startup in development mode.

### 6. Seed sample data (optional)

```bash
npm run db:seed
```

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
| * | `/api/students` | Student CRUD |
| * | `/api/routes` | Route CRUD |
| * | `/api/trips` | Trip management |
| * | `/api/messages` | Messaging |
| * | `/api/location` | Location updates |
| * | `/api/driver` | Driver-specific actions |
| * | `/api/drivers` | Driver management |
| * | `/api/parents` | Parent-specific actions |

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