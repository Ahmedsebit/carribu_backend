const axios = require('axios');
const WebSocket = require('ws');
const { ingestPosition, ingestEvent } = require('./trackerIngestion');

function readConfig(env) {
  if (!env.TRACCAR_ENABLED || env.TRACCAR_ENABLED === 'false') return null;
  if (env.TRACCAR_ENABLED !== 'true') {
    throw new Error('TRACCAR_ENABLED must be true or false.');
  }
  let url;
  try {
    url = new URL(env.TRACCAR_URL);
  } catch {
    throw new Error('TRACCAR_URL must be the hosted Traccar server URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash) {
    throw new Error('TRACCAR_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('TRACCAR_URL must use HTTPS outside localhost.');
  }
  if (!env.TRACCAR_TOKEN?.trim()) throw new Error('TRACCAR_TOKEN is required when Traccar is enabled.');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}/api/`;
  return { baseURL: url.href, token: env.TRACCAR_TOKEN.trim() };
}

// Never log Axios errors directly: their config contains the token and session cookie.
function errorSummary(error) {
  if (error.response?.status) return `HTTP ${error.response.status}`;
  return error.code || 'connection or data processing error';
}

function startTraccarClient({ io, env = process.env } = {}) {
  const config = readConfig(env);
  if (!config) return { stop() {} };

  const http = axios.create({
    baseURL: config.baseURL,
    timeout: 15000,
    maxRedirects: 0,
    headers: { Accept: 'application/json' },
  });
  let stopped = false;
  let active = null;
  let reconnectTimer;
  let retryMs = 1000;

  function dispose(state) {
    state.abort.abort();
    clearInterval(state.heartbeat);
    state.socket?.terminate();
  }

  function reconnect(state, reason) {
    if (stopped || active !== state) return;
    active = null;
    dispose(state);
    console.error(`Traccar connection lost (${reason}); retrying in ${retryMs / 1000}s.`);
    reconnectTimer = setTimeout(connect, retryMs);
    reconnectTimer.unref();
    retryMs = Math.min(retryMs * 2, 30000);
  }

  async function connect() {
    if (stopped) return;
    const state = {
      abort: new AbortController(),
      devices: new Map(),
      socket: null,
      heartbeat: null,
      queue: Promise.resolve(),
    };
    active = state;
    const current = () => !stopped && active === state;
    const request = options => http.request({ ...options, signal: state.abort.signal });

    try {
      const session = await request({ url: 'session', params: { token: config.token } });
      if (!current()) return;
      const cookies = session.headers['set-cookie'];
      const cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .filter(Boolean).map(value => value.split(';')[0]).join('; ');
      if (!cookie) {
        reconnect(state, 'session response did not include a cookie');
        return;
      }
      const get = (url, params) => request({ url, params, headers: { Cookie: cookie } });
      const devices = await get('devices');
      if (!current()) return;
      if (!Array.isArray(devices.data)) {
        reconnect(state, 'invalid devices response');
        return;
      }
      for (const device of devices.data) state.devices.set(device.id, device);

      async function getDevice(id) {
        if (!state.devices.has(id)) {
          const response = await get('devices', { id });
          if (!Array.isArray(response.data)) throw new Error('Invalid devices response.');
          for (const device of response.data) state.devices.set(device.id, device);
        }
        const device = state.devices.get(id);
        if (!device) console.warn(`Traccar update ignored: device ${id} is not accessible.`);
        return device;
      }

      async function processFrame(frame) {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          throw new Error('Invalid Traccar socket message.');
        }
        for (const key of ['devices', 'positions', 'events']) {
          if (frame[key] !== undefined && !Array.isArray(frame[key])) {
            throw new Error('Invalid Traccar socket collection.');
          }
        }
        for (const device of frame.devices || []) {
          if (!current()) return;
          state.devices.set(device.id, { ...state.devices.get(device.id), ...device });
        }
        for (const position of frame.positions || []) {
          if (!current()) return;
          const device = await getDevice(position.deviceId);
          if (!current()) return;
          if (!device) continue;
          const result = await ingestPosition({ position, device });
          if (result.status >= 400) console.error(`Traccar position rejected: ${result.body.error}`);
        }
        for (const event of frame.events || []) {
          if (!current()) return;
          const device = await getDevice(event.deviceId);
          if (!current()) return;
          if (!device) continue;
          const position = (frame.positions || []).find(item => item.id === event.positionId);
          const result = await ingestEvent({ event, device, position }, io);
          if (result.status >= 400) console.error(`Traccar event rejected: ${result.body.error}`);
        }
      }

      const socketUrl = new URL('socket', config.baseURL);
      socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(socketUrl, {
        headers: { Cookie: cookie },
        handshakeTimeout: 15000,
        maxPayload: 8 * 1024 * 1024,
        followRedirects: false,
      });
      state.socket = socket;
      socket.on('error', error => reconnect(state, errorSummary(error)));
      socket.on('close', code => reconnect(state, `WebSocket closed ${code}`));
      socket.on('open', () => {
        // Queue live messages behind the snapshot so a REST response cannot overwrite newer data.
        state.queue = (async () => {
          const positions = await get('positions');
          if (!current()) return;
          if (!Array.isArray(positions.data)) throw new Error('Invalid positions response.');
          await processFrame({ positions: positions.data });
          if (!current()) return;
          retryMs = 1000;
          console.log('Traccar live connection ready.');
        })().catch(error => reconnect(state, errorSummary(error)));
        let alive = true;
        socket.on('pong', () => { alive = true; });
        state.heartbeat = setInterval(() => {
          if (!alive) {
            reconnect(state, 'WebSocket heartbeat timed out');
            return;
          }
          alive = false;
          socket.ping();
        }, 30000);
        state.heartbeat.unref();
      });
      socket.on('message', data => {
        state.queue = state.queue.then(async () => {
          if (current()) await processFrame(JSON.parse(data.toString()));
        }).catch(error => reconnect(state, errorSummary(error)));
      });
    } catch (error) {
      reconnect(state, errorSummary(error));
    }
  }

  void connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (active) dispose(active);
      active = null;
    },
  };
}

module.exports = { startTraccarClient };
