/**
 * End-to-end demo of the acknowledge / delayed / missed trip flow.
 * Requires the backend running on :5000 with the seed data loaded.
 *
 * It logs in as an admin and a driver, opens a live driver socket, then:
 *   1. Schedules a trip 10 min in the future  -> driver gets a reminder (socket)
 *   2. Schedules a trip 5 min in the past      -> flagged "delayed" (socket)
 *   3. Driver ACKNOWLEDGES the delayed trip     -> it officially starts
 *   4. Schedules a trip 45 min in the past      -> flagged "missed" (socket)
 *      and acknowledging it is rejected.
 */
const axios = require('axios');
const { io } = require('socket.io-client');

const API = 'http://localhost:5000/api';
const SOCKET = 'http://localhost:5000';
const OFFSET_HOURS = parseFloat(process.env.SCHOOL_UTC_OFFSET_HOURS || '3');

const ts = () => new Date().toLocaleTimeString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the school-local wall-clock date/time whose start instant is instantMs.
function wallClock(instantMs) {
  const d = new Date(instantMs + OFFSET_HOURS * 3600 * 1000);
  const iso = d.toISOString();
  return { scheduledDate: iso.split('T')[0], scheduledTime: iso.split('T')[1].slice(0, 5) };
}

// Resolve on the next matching socket event, or reject after `timeoutMs`.
function waitFor(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for '${event}'`)); }, timeoutMs);
    const h = (data) => { clearTimeout(t); socket.off(event, h); resolve(data); };
    socket.on(event, h);
  });
}

(async () => {
  // --- Auth ---
  const admin = (await axios.post(`${API}/auth/login`, { email: 'admin@nairobiacademy.co.ke', password: 'admin123' })).data;
  const driver = (await axios.post(`${API}/auth/login`, { email: 'driver1@nairobiacademy.co.ke', password: 'driver123' })).data;
  const A = { headers: { Authorization: `Bearer ${admin.token}` } };
  const D = { headers: { Authorization: `Bearer ${driver.token}` } };
  log('Logged in as admin', admin.user.email, '| driver', driver.user.email, `(id ${driver.user.id})`);

  // --- Live driver socket ---
  const socket = io(SOCKET, { auth: { token: driver.token }, transports: ['websocket'] });
  await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
  log('Driver socket connected. Listening for lifecycle events...\n');
  socket.onAny((event, data) => {
    if (['trip-reminder', 'trip-delayed', 'trip-missed', 'trip-started', 'trip-status'].includes(event)) {
      log(`   🔔 socket '${event}':`, data.message || JSON.stringify(data));
    }
  });

  const routeId = 1; // Westlands–Kilimani Route, assigned to driver1 (id 4)
  const createTrip = async (instantMs, label) => {
    const { scheduledDate, scheduledTime } = wallClock(instantMs);
    const r = (await axios.post(`${API}/trips`, { routeId, type: 'morning_pickup', scheduledDate, scheduledTime }, A)).data;
    log(`Created ${label}: trip #${r.trip.id} scheduled ${scheduledDate} ${scheduledTime} (status ${r.trip.status})`);
    return r.trip.id;
  };
  const findStatus = async (id) => {
    const { trips } = (await axios.get(`${API}/trips`, A)).data;
    return trips.find((t) => t.id === id)?.status;
  };

  // === STEP 1: reminder for an upcoming trip ===============================
  console.log('\n===== STEP 1: Reminder for an upcoming trip =====');
  const reminderPromise = waitFor(socket, 'trip-reminder', 70000);
  const idR = await createTrip(Date.now() + 10 * 60 * 1000, 'UPCOMING trip (starts in 10 min)');

  // === STEP 2: a past-start trip becomes "delayed" =========================
  console.log('\n===== STEP 2: Unacknowledged past-start trip -> DELAYED =====');
  const idD = await createTrip(Date.now() - 5 * 60 * 1000, 'PAST trip (start 5 min ago)');
  const delayedPromise = waitFor(socket, 'trip-delayed', 10000);
  log('Admin loads GET /api/trips (runs the delayed/missed sweeps server-side)...');
  await axios.get(`${API}/trips`, A);
  await delayedPromise.catch((e) => log('   (no socket delayed event:', e.message + ')'));
  log(`Trip #${idD} status is now: ${await findStatus(idD)}`);

  // === STEP 3: driver acknowledges the delayed trip -> starts ==============
  console.log('\n===== STEP 3: Driver ACKNOWLEDGES the delayed trip =====');
  const ack = (await axios.put(`${API}/trips/${idD}/acknowledge`, {}, D)).data;
  log(`   ✅ acknowledge response: "${ack.message}" -> status ${ack.trip.status}, startedAt ${ack.trip.startedAt}`);
  log(`Trip #${idD} status is now: ${await findStatus(idD)}`);

  // === STEP 4: a lapsed trip becomes "missed" and can't be acknowledged ====
  console.log('\n===== STEP 4: Lapsed trip -> MISSED (not started) =====');
  const idM = await createTrip(Date.now() - 45 * 60 * 1000, 'STALE trip (start 45 min ago, past 30m grace)');
  const missedPromise = waitFor(socket, 'trip-missed', 10000);
  log('Admin loads GET /api/trips again...');
  await axios.get(`${API}/trips`, A);
  await missedPromise.catch((e) => log('   (no socket missed event:', e.message + ')'));
  log(`Trip #${idM} status is now: ${await findStatus(idM)}`);
  try {
    await axios.put(`${API}/trips/${idM}/acknowledge`, {}, D);
    log('   ❌ UNEXPECTED: acknowledge of a missed trip succeeded');
  } catch (e) {
    log(`   ✅ acknowledge correctly rejected (${e.response?.status}): "${e.response?.data?.error}"`);
  }

  // Wait out the reminder (fires on the scheduler's ~60s poll) ==============
  console.log('\n===== Waiting for STEP 1 reminder (scheduler polls every 60s)... =====');
  try {
    const rem = await reminderPromise;
    log(`   ✅ reminder received for trip #${rem.tripId}: "${rem.message}"`);
  } catch (e) {
    log('   ⚠️ reminder not received within 70s:', e.message);
  }

  console.log('\n🎉 Demo complete. Summary:');
  console.log(`   #${idR} upcoming (reminder), #${idD} acknowledged->in_progress, #${idM} missed (not started).`);
  socket.close();
  process.exit(0);
})().catch((e) => { console.error('Demo failed:', e.response?.data || e.message); process.exit(1); });
