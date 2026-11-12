jest.mock('../models', () => ({
  User: { findOne: jest.fn() },
  ParentSchool: { findOne: jest.fn() },
  Message: { create: jest.fn(), findByPk: jest.fn() },
}));
jest.mock('../socket', () => ({ notifyUser: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { Op } = require('sequelize');
const { User, ParentSchool, Message } = require('../models');
const controller = require('../controllers/messageController');

const driver = { id: 3, role: 'driver', schoolId: 4 };
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
  recipient = { id: 5, role: 'parent', schoolId: null };
  memberships = [{ parentId: 5, schoolId: 4, isActive: true }];
  messages = [];
  User.findOne.mockImplementation(async ({ where }) => {
    if (where.id !== recipient.id) return null;
    if (where.schoolId != null && where.schoolId !== recipient.schoolId) return null;
    if (where[Op.or] && !where[Op.or].some(condition =>
      Object.entries(condition).every(([key, value]) => recipient[key] === value))) return null;
    return recipient;
  });
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
  expect(response.body.error).toBe('Receiver not found.');
  expect(Message.create).not.toHaveBeenCalled();
});

test('staff recipients remain restricted to the sender school', async () => {
  recipient = { id: 8, role: 'coordinator', schoolId: 99 };
  expect((await send()).status).toBe(404);
  expect(Message.create).not.toHaveBeenCalled();
  recipient.schoolId = 4;
  expect((await send()).status).toBe(201);
  expect(ParentSchool.findOne).not.toHaveBeenCalled();
});

test('parent-to-driver messaging continues using the driver school', async () => {
  actor = { id: 5, role: 'parent', schoolId: null };
  recipient = driver;
  const response = await send({ content: 'Parent message' });
  expect(response.status).toBe(201);
  expect(response.body.message).toMatchObject({
    schoolId: 4, senderId: 5, receiverId: 3, content: 'Parent message',
  });
});

test('a missing recipient still returns a not-found response', async () => {
  User.findOne.mockResolvedValueOnce(null);
  expect((await send()).status).toBe(404);
  expect(Message.create).not.toHaveBeenCalled();
});
