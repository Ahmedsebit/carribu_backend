const http = require('http');
const { WebSocketServer } = require('ws');

jest.mock('../services/trackerIngestion', () => ({
  ingestPosition: jest.fn(),
  ingestEvent: jest.fn(),
}));

const { ingestPosition, ingestEvent } = require('../services/trackerIngestion');
const { startTraccarClient } = require('../services/traccarClient');

async function until(assertion) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

describe('hosted Traccar REST and WebSocket connection', () => {
  let server, sockets, client, env, requests, devices, positions;
  let sessionStatus, includeCookie, positionsResponse, connectionCookie, io;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    ingestPosition.mockResolvedValue({ status: 201, body: { accepted: true } });
    ingestEvent.mockResolvedValue({ status: 201, body: { accepted: true } });
    requests = [];
    devices = [{ id: 7, uniqueId: 'test-imei' }];
    positions = [{ id: 101, deviceId: 7, latitude: -1.2, longitude: 36.8 }];
    sessionStatus = 200;
    includeCookie = true;
    positionsResponse = null;
    connectionCookie = null;
    io = {};
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ path: url.pathname, token: url.searchParams.get('token'), cookie: req.headers.cookie });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/session') {
        res.statusCode = sessionStatus;
        if (includeCookie) res.setHeader('Set-Cookie', ['JSESSIONID=test-session; HttpOnly; Path=/']);
        res.end(JSON.stringify({ id: 1 }));
      } else if (req.headers.cookie !== 'JSESSIONID=test-session') {
        res.writeHead(401).end('{}');
      } else if (url.pathname === '/api/devices') {
        const id = url.searchParams.get('id');
        res.end(JSON.stringify(id ? devices.filter(device => device.id === Number(id)) : devices));
      } else if (url.pathname === '/api/positions') {
        if (positionsResponse) positionsResponse(res);
        else res.end(JSON.stringify(positions));
      } else {
        res.writeHead(404).end('{}');
      }
    });
    sockets = new WebSocketServer({ server, path: '/api/socket' });
    sockets.on('connection', (socket, req) => { connectionCookie = req.headers.cookie; });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env = {
      TRACCAR_ENABLED: 'true',
      TRACCAR_URL: `http://127.0.0.1:${server.address().port}`,
      TRACCAR_TOKEN: 'test-account-token-not-a-secret',
    };
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    jest.restoreAllMocks();
  });

  function broadcast(frame) {
    for (const socket of sockets.clients) socket.send(JSON.stringify(frame));
  }

  test('authenticates with a token, uses cookies, and ingests latest positions', async () => {
    env.TRACCAR_URL += '/api/';
    client = startTraccarClient({ env, io });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    expect(requests.map(req => req.path)).toEqual(['/api/session', '/api/devices', '/api/positions']);
    expect(requests[0].token).toBe(env.TRACCAR_TOKEN);
    expect(requests.slice(1).every(req => req.token === null)).toBe(true);
    expect(connectionCookie).toBe('JSESSIONID=test-session');
    expect(ingestPosition).toHaveBeenCalledWith({ position: positions[0], device: devices[0] });
  });

  test('queues live messages behind the REST snapshot', async () => {
    let release;
    positionsResponse = res => { release = () => res.end(JSON.stringify(positions)); };
    client = startTraccarClient({ env });
    await until(() => expect(release).toBeDefined());
    broadcast({ positions: [{ ...positions[0], id: 102 }] });
    expect(ingestPosition).not.toHaveBeenCalled();
    release();
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(2));
    expect(ingestPosition.mock.calls.map(([payload]) => payload.position.id)).toEqual([101, 102]);
  });

  test('handles independent device, position, and event messages and resolves new devices', async () => {
    client = startTraccarClient({ env, io });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    broadcast({ devices: [{ id: 7, status: 'online' }] });
    const event = { id: 201, deviceId: 7, type: 'alarm' };
    broadcast({ events: [event] });
    devices.push({ id: 8, uniqueId: 'second-imei' });
    const position = { ...positions[0], deviceId: 8, id: 102 };
    broadcast({ positions: [position] });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(2));
    expect(ingestEvent).toHaveBeenCalledWith({
      event, device: { ...devices[0], status: 'online' }, position: undefined,
    }, io);
    expect(ingestPosition).toHaveBeenLastCalledWith({ position, device: devices[1] });
    expect(requests.filter(req => req.path === '/api/devices')).toHaveLength(2);
  });

  test('reloads the session, devices, and latest positions after disconnecting', async () => {
    client = startTraccarClient({ env });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    positions = [{ ...positions[0], id: 103 }];
    for (const socket of sockets.clients) socket.close();
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(2));
    expect(requests.filter(req => req.path === '/api/session')).toHaveLength(2);
    expect(ingestPosition.mock.calls[1][0].position.id).toBe(103);
  });

  test('logs authentication failure without exposing tokens and retries with a new session', async () => {
    sessionStatus = 401;
    client = startTraccarClient({ env });
    await until(() => expect(console.error).toHaveBeenCalled());
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(env.TRACCAR_TOKEN);
    expect(connectionCookie).toBeNull();
    sessionStatus = 200;
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
  });

  test('refuses a session without a cookie', async () => {
    includeCookie = false;
    client = startTraccarClient({ env });
    await until(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining('did not include a cookie')));
    expect(connectionCookie).toBeNull();
    expect(ingestPosition).not.toHaveBeenCalled();
  });

  test('renews authentication when loading the snapshot fails', async () => {
    positionsResponse = res => res.writeHead(401).end('{}');
    client = startTraccarClient({ env });
    await until(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 401')));
    positionsResponse = null;
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    expect(requests.filter(req => req.path === '/api/session')).toHaveLength(2);
  });

  test('detects a missing heartbeat response', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    client = startTraccarClient({ env });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30000)[0];
    heartbeat();
    heartbeat();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('heartbeat timed out'));
  });

  test('reconnects after malformed live data or processing failures', async () => {
    client = startTraccarClient({ env });
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(1));
    broadcast({ positions: {} });
    await until(() => expect(console.error).toHaveBeenCalled());
    await until(() => expect(ingestPosition).toHaveBeenCalledTimes(2));
    ingestPosition.mockRejectedValueOnce(Object.assign(new Error('database failure'), { code: 'DB_FAILED' }));
    broadcast({ positions: [{ ...positions[0], id: 104 }] });
    await until(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DB_FAILED')));
  });

  test('stop cancels reconnects', async () => {
    sessionStatus = 401;
    client = startTraccarClient({ env });
    await until(() => expect(console.error).toHaveBeenCalled());
    client.stop();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(requests).toHaveLength(1);
  });

  test('stop aborts an in-flight REST initialization', async () => {
    let pendingResponse;
    positionsResponse = res => { pendingResponse = res; };
    client = startTraccarClient({ env });
    await until(() => expect(pendingResponse).toBeDefined());
    client.stop();
    await until(() => expect(pendingResponse.destroyed).toBe(true));
    expect(ingestPosition).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test('stays disabled by default and rejects unsafe or incomplete enabled configuration', () => {
    client = startTraccarClient({ env: {} });
    expect(requests).toHaveLength(0);
    expect(() => startTraccarClient({ env: { ...env, TRACCAR_TOKEN: '' } })).toThrow('TRACCAR_TOKEN');
    expect(() => startTraccarClient({ env: { ...env, TRACCAR_URL: 'http://example.com' } })).toThrow('HTTPS');
    expect(() => startTraccarClient({ env: { ...env, TRACCAR_URL: 'https://example.com?token=bad' } })).toThrow('without credentials');
    expect(() => startTraccarClient({ env: { ...env, TRACCAR_ENABLED: 'yes' } })).toThrow('true or false');
  });
});
