const { Op } = require('sequelize');
jest.mock('../models', () => ({
  sequelize: {}, User: {}, School: {}, Vehicle: {}, TripLog: {},
  ParentSchool: { findAll: jest.fn() }, Student: { findAll: jest.fn() }, Route: {},
  Trip: { findAll: jest.fn() },
}));
jest.mock('../utils/email', () => ({}));
jest.mock('../socket', () => ({}));
jest.mock('../services/tripReminders', () => ({
  ...jest.requireActual('../services/tripReminders'),
  checkDelayedTrips: jest.fn(), checkMissedTrips: jest.fn(),
}));
const models = require('../models');
const controller = require('../controllers/parentController');
const reminders = require('../services/tripReminders');
const { buildTripPlan } = require('../services/tripPlan');
const response = () => {
  const res = {};
  res.status = jest.fn(() => res); res.json = jest.fn(() => res);
  return res;
};
let child, trip;
beforeEach(() => {
  jest.clearAllMocks();
  child = { id: 20, parentId: 5, schoolId: 4, isActive: true, firstName: 'Test', lastName: 'Child',
    school: { id: 4, name: 'Test school' }, routes: [] };
  const original = { id: 9, schoolId: 4, name: 'Original route', students: [child] };
  trip = {
    id: 30, routeId: 9, status: 'completed', type: 'morning_pickup', scheduledDate: reminders.schoolDate(),
    route: { id: 9, schoolId: 4, name: 'Renamed route', school: child.school },
    plan: buildTripPlan({ type: 'morning_pickup' }, original), logs: [],
  };
  models.ParentSchool.findAll.mockResolvedValue([{ schoolId: 4 }]);
  models.Student.findAll.mockResolvedValue([child]);
  models.Trip.findAll.mockImplementation(async () => [{ toJSON: () => trip }]);
});
test('past journeys use frozen participation after route removal rather than the current route', async () => {
  const res = response();
  await controller.getTripHistory({ user: { id: 5 }, query: {} }, res);
  expect(res.json.mock.calls[0][0].trips).toEqual([expect.objectContaining({
    id: 30, route: { id: 9, name: 'Original route' }, rosterSource: 'trip_plan',
    children: [expect.objectContaining({ studentId: 20, studentName: 'Test Child' })],
  })]);
  const where = models.Trip.findAll.mock.calls[0][0].where;
  expect(where.routeId).toBeUndefined();
  expect(where.status[Op.in]).toEqual(['completed', 'cancelled', 'missed']);
});
test.each(['foreign parent', 'foreign school'])('frozen history does not expose %s participation', async reason => {
  if (reason === 'foreign parent') trip.plan.stops[0].parentId = 8;
  else trip.plan.schoolId = 99;
  const res = response();
  await controller.getTripHistory({ user: { id: 5 }, query: {} }, res);
  expect(res.json.mock.calls[0][0].trips).toEqual([]);
});
test('legacy history contains only children with recorded events and retains their known names', async () => {
  trip.plan = null;
  trip.logs = [{ id: 1, studentId: 20, action: 'check_in', timestamp: new Date().toISOString() }];
  const res = response();
  await controller.getTripHistory({ user: { id: 5 }, query: {} }, res);
  expect(res.json.mock.calls[0][0].trips[0]).toMatchObject({
    rosterSource: 'recorded_logs', children: [{ studentName: 'Test Child', status: 'on_bus' }],
  });
});
test.each(['missed', 'cancelled'])('today’s %s journey remains visible without current routes', async status => {
  trip.status = status;
  const res = response();
  await controller.getUpcomingTrips({ user: { id: 5 }, query: { includeDisruptions: 'true' } }, res);
  const body = res.json.mock.calls[0][0];
  expect(body.trips).toEqual([expect.objectContaining({ id: 30, status, route: { id: 9, name: 'Original route' } })]);
  expect(body.schoolDate).toBe(reminders.schoolDate());
  const branches = models.Trip.findAll.mock.calls[0][0].where[Op.or];
  expect(branches[1][Op.or][0].plan[Op.contains]).toEqual({ stops: [{ studentId: 20, parentId: 5 }] });
});
test('upcoming range starts on the school date even before UTC midnight', async () => {
  const offset = Number(process.env.SCHOOL_UTC_OFFSET_HOURS || 3) * 3600000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-11-21T00:05:00Z') - offset);
  try {
    child.routes = [{ id: 9 }]; trip.status = 'scheduled';
    const res = response();
    await controller.getUpcomingTrips({ user: { id: 5 }, query: {} }, res);
    expect(models.Trip.findAll.mock.calls[0][0].where.scheduledDate[Op.between]).toEqual(['2099-11-21', '2099-11-21']);
  } finally { clock.mockRestore(); }
});
