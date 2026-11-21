jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  User: { findByPk: jest.fn() },
  Route: { findOne: jest.fn() },
  ParentSchool: { findOne: jest.fn() },
  Message: { create: jest.fn(), findByPk: jest.fn() },
}));
jest.mock('../socket', () => ({ notifyUser: jest.fn() }));
jest.mock('../services/notificationOutbox', () => ({ enqueueMessageNotification: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { sequelize, User, ParentSchool, Message, Route } = require('../models');
const controller = require('../controllers/messageController');

const driver = { id: 3, role: 'driver', schoolId: 4, isActive: true, authVersion: 0 };
let actor, recipient, memberships, messages;
const app = express();
app.use(express.json());
app.post('/messages', (req, res, next) => { req.user = actor; next(); }, controller.send);
const send = (body = {}) => request(app).post('/messages').send({
  receiverId: recipient.id, content: 'Driver reply', ...body,
});

beforeEach(() => {
  jest.resetAllMocks();
  actor = driver;
  recipient = { id: 5, role: 'parent', schoolId: null, isActive: true, mustSetPassword: false };
  memberships = [{ parentId: 5, schoolId: 4, isActive: true }];
  messages = [];
  sequelize.transaction.mockImplementation(callback => callback({ LOCK: { SHARE: 'SHARE' } }));
  User.findByPk.mockImplementation(async id => id === recipient.id ? recipient : id === actor.id ? actor : null);
  Route.findOne.mockResolvedValue({ id: 9 });
  ParentSchool.findOne.mockImplementation(async ({ where }) => memberships.find(membership =>
    Object.entries(where).every(([key, value]) => membership[key] === value)) || null);
  Message.create.mockImplementation(async values => {
    const message = { id: messages.length + 1, ...values };
    messages.push(message);
    return message;
  });
  Message.findByPk.mockImplementation(async id => messages.find(message => message.id === id));
});

test.each([null, 99])('driver replies reach an actively linked parent whose user schoolId is %p', async schoolId => {
  recipient.schoolId = schoolId;
  const response = await send();
  expect(response.status).toBe(201);
  expect(response.body.message).toMatchObject({
    schoolId: 4, senderId: 3, receiverId: 5, content: 'Driver reply', messageType: 'text',
  });
  expect(ParentSchool.findOne).toHaveBeenCalledWith(expect.objectContaining({
    where: { parentId: 5, schoolId: 4, isActive: true },
  }));
});

test.each(['school_admin', 'coordinator'])('%s can message a parent with an active school membership', async role => {
  actor = { ...driver, role };
  expect((await send()).status).toBe(201);
  expect(messages[0].schoolId).toBe(4);
});

test.each([
  { links: [] },
  { links: [{ parentId: 5, schoolId: 4, isActive: false }] },
  { links: [{ parentId: 5, schoolId: 99, isActive: true }] },
])('driver cannot reply to a parent without an active membership in their school: %p', async ({ links }) => {
  memberships = links;
  recipient.schoolId = 4;
  const response = await send();
  expect(response.status).toBe(404);
  expect(response.body.error).toMatch(/not found/i);
  expect(Message.create).not.toHaveBeenCalled();
});

test('staff recipients remain restricted to the sender school', async () => {
  recipient = { id: 8, role: 'coordinator', schoolId: 99, isActive: true };
  expect((await send()).status).toBe(404);
  expect(Message.create).not.toHaveBeenCalled();
  recipient.schoolId = 4;
  expect((await send()).status).toBe(201);
  expect(ParentSchool.findOne).not.toHaveBeenCalled();
});

test('parent-to-driver messaging continues using the driver school', async () => {
  actor = { id: 5, role: 'parent', schoolId: null, isActive: true, authVersion: 0 };
  recipient = driver;
  const response = await send({ content: 'Parent message' });
  expect(response.status).toBe(201);
  expect(response.body.message).toMatchObject({
    schoolId: 4, senderId: 5, receiverId: 3, content: 'Parent message',
  });
});

test('a missing recipient still returns a not-found response', async () => {
  User.findByPk.mockResolvedValueOnce(null);
  expect((await send()).status).toBe(404);
  expect(Message.create).not.toHaveBeenCalled();
});
