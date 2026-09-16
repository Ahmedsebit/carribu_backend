const messageController = require('../controllers/messageController');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { Message, User } = require('../models');

const invoke = async (handler, req) => {
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  await handler(req, res);
  return response;
};

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

describe('Deleted message participants', () => {
  test('conversations omit orphaned participants instead of returning an error', async () => {
    const { school, parent } = getTestData();
    const driver = await User.create({
      schoolId: school.id,
      email: 'deleted-message-driver@test.com',
      passwordHash: 'password',
      firstName: 'Deleted',
      lastName: 'Driver',
      role: 'driver',
      phone: '+254711222339',
    });
    await Message.create({
      schoolId: school.id,
      senderId: driver.id,
      receiverId: parent.id,
      content: 'Historical message from a deleted driver.',
      messageType: 'text',
    });
    await driver.destroy();

    const response = await invoke(messageController.getConversations, {
      user: { id: parent.id, role: 'parent', schoolId: school.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.conversations).toBeInstanceOf(Array);
    expect(response.body.conversations.some(conversation => conversation.partnerId == null)).toBe(false);
  });

  test('notifications provide a safe sender label for orphaned history', async () => {
    const { school, parent } = getTestData();
    const driver = await User.create({
      schoolId: school.id,
      email: 'deleted-notification-driver@test.com',
      passwordHash: 'password',
      firstName: 'Deleted',
      lastName: 'Notifier',
      role: 'driver',
      phone: '+254711222340',
    });
    const notification = await Message.create({
      schoolId: school.id,
      senderId: driver.id,
      receiverId: parent.id,
      content: 'Historical notification from a deleted driver.',
      messageType: 'alert',
    });
    await driver.destroy();

    const response = await invoke(messageController.getNotifications, {
      user: { id: parent.id, role: 'parent', schoolId: school.id },
    });

    expect(response.statusCode).toBe(200);
    const item = response.body.notifications.find(entry => entry.id === notification.id);
    expect(item.sender).toEqual({
      id: null,
      firstName: 'Deleted',
      lastName: 'user',
      role: null,
    });
  });

  describe('Per-user message deletion', () => {
    test('removing one message hides it only from the requesting user', async () => {
      const { school, driver, parent } = getTestData();
      const message = await Message.create({
        schoolId: school.id,
        senderId: driver.id,
        receiverId: parent.id,
        content: 'Remove only for the parent.',
        messageType: 'text',
      });

      const deleteResponse = await invoke(messageController.deleteMessage, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
        params: { id: message.id },
      });
      expect(deleteResponse.statusCode).toBe(200);

      const parentThread = await invoke(messageController.getThread, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
        params: { partnerId: String(driver.id) },
        query: {},
      });
      expect(parentThread.body.messages.some(item => item.id === message.id)).toBe(false);

      const driverThread = await invoke(messageController.getThread, {
        user: { id: driver.id, role: 'driver', schoolId: school.id },
        params: { partnerId: String(parent.id) },
        query: {},
      });
      expect(driverThread.body.messages.some(item => item.id === message.id)).toBe(true);
    });

    test('clearing a conversation hides existing messages but not later messages', async () => {
      const { school, driver, parent } = getTestData();
      await Message.create({
        schoolId: school.id,
        senderId: parent.id,
        receiverId: driver.id,
        content: 'Message before clearing.',
        messageType: 'text',
      });

      const clearResponse = await invoke(messageController.clearThread, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
        params: { partnerId: String(driver.id) },
      });
      expect(clearResponse.statusCode).toBe(200);

      const laterMessage = await Message.create({
        schoolId: school.id,
        senderId: driver.id,
        receiverId: parent.id,
        content: 'Message after clearing.',
        messageType: 'text',
      });
      const parentThread = await invoke(messageController.getThread, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
        params: { partnerId: String(driver.id) },
        query: {},
      });

      expect(parentThread.body.messages.map(item => item.id)).toEqual([laterMessage.id]);
    });

    test('clearing notifications removes them only from the receiver notification list', async () => {
      const { school, driver, parent } = getTestData();
      const notification = await Message.create({
        schoolId: school.id,
        senderId: driver.id,
        receiverId: parent.id,
        content: 'Notification to clear.',
        messageType: 'alert',
      });

      const clearResponse = await invoke(messageController.clearNotifications, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
      });
      expect(clearResponse.statusCode).toBe(200);

      const notifications = await invoke(messageController.getNotifications, {
        user: { id: parent.id, role: 'parent', schoolId: school.id },
      });
      expect(notifications.body.notifications.some(item => item.id === notification.id)).toBe(false);

      const driverThread = await invoke(messageController.getThread, {
        user: { id: driver.id, role: 'driver', schoolId: school.id },
        params: { partnerId: String(parent.id) },
        query: {},
      });
      expect(driverThread.body.messages.some(item => item.id === notification.id)).toBe(true);
    });
  });
});
