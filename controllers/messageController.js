const { Message, User, Trip, Route, Student, School, RouteStudent, AbsenceRequest, sequelize } = require('../models');
const { Op } = require('sequelize');
const { getActiveParentSchoolIds, getActiveParentIdsForSchool, hasActiveParentSchool } = require('../utils/parentSchoolAccess');
const { lockSchool } = require('../services/tripWorkflow');
const { schoolDate } = require('../services/tripReminders');
const { positiveId, getMessagePermission } = require('../services/messageAccess');
const { enqueueMessageNotification } = require('../services/notificationOutbox');
const fail = (status, message) => Object.assign(new Error(message), { status });
const messageIncludes = [
  { model: User, as: 'sender', attributes: ['id', 'firstName', 'lastName', 'role'] },
  { model: User, as: 'receiver', attributes: ['id', 'firstName', 'lastName', 'role'] },
];

const visibleToUser = userId => ({
  [Op.or]: [
    { senderId: userId, senderDeletedAt: null },
    { receiverId: userId, receiverDeletedAt: null },
  ],
});

exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const where = visibleToUser(userId);
    where.schoolId = req.user.role === 'parent'
      ? { [Op.in]: await getActiveParentSchoolIds(userId) } : req.user.schoolId;
    const messages = await Message.findAll({ where, include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role','phone'] }, { model: User, as: 'receiver', attributes: ['id','firstName','lastName','role','phone'] }], order: [['created_at','DESC']] });
    const map = {};
    messages.forEach(msg => {
      const pid = msg.senderId === userId ? msg.receiverId : msg.senderId;
      const p = msg.senderId === userId ? msg.receiver : msg.sender;
      // Older hard-deleted users leave messages with a null participant.
      // They cannot form a usable thread, so omit them instead of failing the
      // entire conversations response.
      if (!pid || !p) return;
      if (!map[pid]) { map[pid] = { partnerId: pid, partnerName: `${p.firstName} ${p.lastName}`, partnerRole: p.role, partnerPhone: p.phone, lastMessage: msg.content, lastMessageTime: msg.createdAt, lastMessageType: msg.messageType, unreadCount: 0 }; }
      if (msg.receiverId === userId && !msg.isRead) map[pid].unreadCount++;
    });
    const conversations = await Promise.all(Object.values(map).map(async conversation => {
      const permission = await getMessagePermission(req.user, conversation.partnerId);
      return { ...conversation, canMessage: !!permission, partnerPhone: permission ? conversation.partnerPhone : null };
    }));
    res.json({ conversations });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getThread = async (req, res) => {
  try {
    const userId = req.user.id; const partnerId = positiveId(req.params.partnerId);
    if (!partnerId) return res.status(400).json({ error: 'A valid partnerId is required.' });
    const limit = req.query.limit == null ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, 'limit must be between 1 and 100.');
    const beforeId = req.query.beforeId == null ? null : positiveId(req.query.beforeId);
    if (req.query.beforeId != null && !beforeId) throw fail(400, 'A valid beforeId is required.');
    const where = {
      [Op.or]: [
        { senderId: userId, receiverId: partnerId, senderDeletedAt: null },
        { senderId: partnerId, receiverId: userId, receiverDeletedAt: null },
      ],
    };
    where.schoolId = req.user.role === 'parent'
      ? { [Op.in]: await getActiveParentSchoolIds(userId) } : req.user.schoolId;
    if (beforeId) where.id = { [Op.lt]: beforeId };
    const permission = await getMessagePermission(req.user, partnerId);
    const rows = await Message.findAll({ where, include: messageIncludes, order: [['id', 'DESC']], limit: limit + 1 });
    if (!rows.length && !permission) throw fail(404, 'Conversation not found.');
    const messages = rows.slice(0, limit).reverse();
    const receivedIds = messages.filter(message => message.receiverId === userId && !message.isRead).map(message => message.id);
    if (receivedIds.length) await Message.update({ isRead: true }, {
      where: { id: { [Op.in]: receivedIds }, receiverId: userId, isRead: false },
    });
    res.json({ messages, total: messages.length, hasMore: rows.length > limit, canMessage: !!permission });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.send = async (req, res) => {
  try {
    const receiverId = positiveId(req.body.receiverId);
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const tripId = req.body.tripId == null ? null : positiveId(req.body.tripId);
    const { clientMessageId } = req.body;
    if (!receiverId || !content || content.length > 2000) throw fail(400, 'A valid receiver and message of 1–2000 characters are required.');
    if (req.body.tripId != null && !tripId) throw fail(400, 'A valid tripId is required.');
    if ([req.body.messageType, req.body.type].some(type => type != null && type !== 'text')) {
      throw fail(400, 'Chat messages must be text. Use the dedicated absence or school-notification workflow.');
    }
    if (clientMessageId != null && (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMessageId))) {
      throw fail(400, 'Invalid clientMessageId.');
    }
    const permission = await getMessagePermission(req.user, receiverId, { tripId });
    if (!permission) throw fail(404, 'Receiver or trip not found for your current assignment.');
    const matches = message => message.receiverId === receiverId && message.content === content
      && (message.tripId || null) === tripId && message.schoolId === permission.schoolId && message.messageType === 'text';
    let result;
    try {
      result = await sequelize.transaction(async transaction => {
        await lockSchool(permission.schoolId, transaction);
        const sender = await User.findByPk(req.user.id, { transaction, lock: transaction.LOCK.SHARE });
        if (!sender?.isActive) throw fail(401, 'Your account is inactive.');
        if ((sender.authVersion || 0) !== req.user.authVersion) throw fail(401, 'This session is no longer valid.');
        const current = await getMessagePermission(sender, receiverId, { tripId, transaction });
        if (current?.schoolId !== permission.schoolId) throw fail(404, 'Receiver or trip not found for your current assignment.');
        const existing = clientMessageId ? await Message.findOne({
          where: { senderId: req.user.id, clientMessageId }, transaction,
        }) : null;
        if (existing) {
          if (!matches(existing)) throw fail(409, 'This clientMessageId was already used for a different message.');
          return { message: existing, duplicate: true };
        }
        const message = await Message.create({
          schoolId: permission.schoolId, senderId: req.user.id, receiverId, content,
          messageType: 'text', tripId, clientMessageId: clientMessageId || null,
        }, { transaction });
        await enqueueMessageNotification(message, transaction);
        return { message, duplicate: false };
      });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError' || !clientMessageId) throw err;
      const existing = await Message.findOne({ where: { senderId: req.user.id, clientMessageId } });
      if (!existing || !matches(existing)) throw fail(409, 'This clientMessageId was already used for a different message.');
      result = { message: existing, duplicate: true };
    }
    const full = await Message.findByPk(result.message.id, { include: messageIncludes });
    res.status(result.duplicate ? 200 : 201).json({ message: full, duplicate: result.duplicate });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

exports.sendTripNotification = async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    const allTrips = req.body.allTrips === true;
    const date = String(req.body.date || '').trim();
    const tripIds = [...new Set(
      (Array.isArray(req.body.tripIds) ? req.body.tripIds : [])
        .map(id => parseInt(id, 10))
        .filter(Number.isInteger)
    )];

    if (!content) return res.status(400).json({ error: 'Notification message is required.' });
    if (content.length > 2000) return res.status(400).json({ error: 'Notification message must be 2000 characters or fewer.' });
    if (allTrips && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'A valid date is required when notifying all trips.' });
    }
    if (!allTrips && tripIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one trip.' });
    }

    const where = allTrips ? { scheduledDate: date } : { id: { [Op.in]: tripIds } };
    const trips = await Trip.findAll({
      where,
      attributes: ['id', 'status', 'plan'],
      include: [{
        model: Route,
        as: 'route',
        where: { schoolId: req.user.schoolId },
        required: true,
        attributes: ['id', 'name'],
        include: [{
          model: Student,
          as: 'students',
          where: { isActive: true, schoolId: req.user.schoolId },
          required: false,
          attributes: ['id', 'parentId', 'schoolId'],
          through: { attributes: [] },
          include: [{
            model: User,
            as: 'parent',
            where: { role: 'parent', isActive: true },
            required: false,
            attributes: ['id'],
          }],
        }],
      }],
    });

    if (!allTrips && trips.length !== tripIds.length) {
      return res.status(404).json({ error: 'One or more selected trips were not found for this school.' });
    }
    if (trips.length === 0) return res.status(400).json({ error: 'No trips were found for this notification.' });

    const recipients = new Map();
    for (const trip of trips) {
      if (trip.plan?.schoolId != null && trip.plan.schoolId !== req.user.schoolId) {
        return res.status(404).json({ error: 'One or more selected trips were not found for this school.' });
      }
      const frozen = trip.plan && ['in_progress', 'completed', 'cancelled', 'missed'].includes(trip.status);
      const students = frozen ? await Student.findAll({
        where: { id: { [Op.in]: (trip.plan.stops || []).map(stop => stop.studentId) }, schoolId: req.user.schoolId, isActive: true },
        attributes: ['id', 'parentId', 'schoolId'],
        include: [{ model: User, as: 'parent', where: { role: 'parent', isActive: true }, required: true, attributes: ['id'] }],
      }) : trip.route?.students || [];
      students.forEach(student => {
        if (!student.parent) return;
        if (frozen && !trip.plan.stops.some(stop => stop.studentId === student.id && stop.parentId === student.parentId)) return;
        const parentTrips = recipients.get(student.parent.id) || new Set();
        parentTrips.add(trip.id);
        recipients.set(student.parent.id, parentTrips);
      });
    }
    const activeParentIds = await getActiveParentIdsForSchool(
      [...recipients.keys()],
      req.user.schoolId
    );
    for (const parentId of recipients.keys()) {
      if (!activeParentIds.has(parentId)) recipients.delete(parentId);
    }
    if (recipients.size === 0) {
      return res.status(400).json({ error: 'The selected trips do not have any linked parents.' });
    }

    await sequelize.transaction(async transaction => {
      await lockSchool(req.user.schoolId, transaction);
      const sender = await User.findByPk(req.user.id, { transaction, lock: transaction.LOCK.SHARE });
      if (!sender?.isActive || !['school_admin', 'coordinator'].includes(sender.role) || sender.schoolId !== req.user.schoolId) {
        throw fail(403, 'Your school notification access is no longer active.');
      }
      for (const [parentId, parentTrips] of recipients) {
        const message = await Message.create({
          schoolId: req.user.schoolId,
          senderId: req.user.id,
          receiverId: parentId,
          tripId: parentTrips.size === 1 ? [...parentTrips][0] : null,
          content,
          messageType: 'alert',
        }, { transaction });
        await enqueueMessageNotification(message, transaction);
      }
    });

    res.status(201).json({
      message: `Notification sent to ${recipients.size} ${recipients.size === 1 ? 'parent' : 'parents'}.`,
      recipientCount: recipients.size,
      tripCount: trips.length,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.reportAbsence = async (req, res) => {
  try {
    if (req.user.role !== 'parent') return res.status(403).json({ error: 'Only parents can submit absence requests.' });
    const { studentId, studentIds, reason, date } = req.body;
    const rawIds = Array.isArray(studentIds) ? studentIds : studentId != null ? [studentId] : [];
    if (rawIds.some(id => !['string', 'number'].includes(typeof id))) {
      return res.status(400).json({ error: 'Student IDs must be numbers.' });
    }
    const ids = [...new Set(rawIds.map(Number))];
    if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'Valid studentId or studentIds are required.' });
    }
    const requestedDate = date || schoolDate();
    const parsedDate = new Date(`${requestedDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !Number.isFinite(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== requestedDate) {
      return res.status(400).json({ error: 'A valid absence date is required.' });
    }
    if (reason != null && (typeof reason !== 'string' || reason.length > 2000)) {
      return res.status(400).json({ error: 'Reason must be text of at most 2000 characters.' });
    }
    const activeSchoolIds = await getActiveParentSchoolIds(req.user.id);
    const where = { id: ids, schoolId: { [Op.in]: activeSchoolIds }, parentId: req.user.id, isActive: true };
    const owned = await Student.findAll({ where, attributes: ['id', 'schoolId'] });
    if (owned.length !== ids.length) return res.status(404).json({ error: 'Student(s) not found.' });
    const result = await sequelize.transaction(async transaction => {
      for (const schoolId of [...new Set(owned.map(student => student.schoolId))].sort((a, b) => a - b)) {
        await lockSchool(schoolId, transaction);
      }
      const students = await Student.findAll({
        where, transaction,
        include: [{ model: Route, as: 'routes', include: [{ model: User, as: 'driver', attributes: ['id', 'schoolId', 'isActive'] }] }],
      });
      if (students.length !== ids.length) throw Object.assign(new Error('Student access has changed. Refresh and try again.'), { status: 409 });
      let notifications = 0;
      const requests = [];
      for (const student of students) {
        const existing = await AbsenceRequest.findOne({
          where: { schoolId: student.schoolId, studentId: student.id, date: requestedDate, status: { [Op.ne]: 'rejected' } },
          transaction,
        });
        const request = existing || await AbsenceRequest.create({
          schoolId: student.schoolId, studentId: student.id, parentId: req.user.id,
          date: requestedDate, reason: reason?.trim() || null,
        }, { transaction });
        requests.push({ id: request.id, studentId: student.id, date: requestedDate, status: request.status });
        if (existing) continue;
        const notified = new Set();
        for (const route of student.routes || []) {
          if (route.schoolId !== student.schoolId || !route.driver?.isActive
            || route.driver.schoolId !== student.schoolId || notified.has(route.driver.id)) continue;
          const message = await Message.create({
            schoolId: student.schoolId, senderId: req.user.id, receiverId: route.driver.id,
            content: `⚠️ ABSENCE: ${student.firstName} ${student.lastName} absent on ${requestedDate}. Reason: ${reason?.trim() || 'Not specified'}. Staff confirmation is required before recording attendance.`,
            messageType: 'absence',
          }, { transaction });
          await enqueueMessageNotification(message, transaction);
          notified.add(route.driver.id);
          notifications += 1;
        }
      }
      return { requests, notifications };
    });
    res.status(201).json({ message: 'Absence request recorded for staff review.', ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.getUnreadCount = async (req, res) => {
  try {
    const where = { receiverId: req.user.id, receiverDeletedAt: null, isRead: false };
    if (req.user.role === 'parent') {
      const activeSchoolIds = await getActiveParentSchoolIds(req.user.id);
      where[Op.or] = [
        { messageType: { [Op.in]: ['text', 'absence'] } },
        {
          messageType: { [Op.in]: ['alert', 'arrival', 'system'] },
          schoolId: { [Op.in]: activeSchoolIds },
        },
      ];
    }
    const count = await Message.count({ where });
    res.json({ unreadCount: count });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getRouteParents = async (req, res) => {
  try {
    const where = { id: req.params.routeId, schoolId: req.user.schoolId };
    if (req.user.role === 'driver') where.driverId = req.user.id;
    const route = await Route.findOne({ where, include: [{
      model: Student, as: 'students', where: { schoolId: req.user.schoolId, isActive: true }, required: false,
      include: [{ model: User, as: 'parent', where: { role: 'parent', isActive: true }, required: false, attributes: ['id','firstName','lastName','phone','email'] }],
    }] });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const activeParents = await getActiveParentIdsForSchool((route.students || []).map(student => student.parentId), req.user.schoolId);
    const parents = []; const seen = new Set();
    (route.students || []).forEach(s => { if (s.parent && activeParents.has(s.parent.id) && !seen.has(s.parent.id)) { seen.add(s.parent.id); parents.push({ ...s.parent.toJSON(), children: route.students.filter(st => st.parentId === s.parent.id).map(st => ({ id: st.id, firstName: st.firstName, lastName: st.lastName, grade: st.grade })) }); } });
    res.json({ parents, total: parents.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
// Get drivers assigned to routes that have this parent's children
exports.getMyDrivers = async (req, res) => {
  try {
    const userId = req.user.id;
    const activeSchoolIds = await getActiveParentSchoolIds(userId);
    const children = await Student.findAll({
      where: { parentId: userId, schoolId: { [Op.in]: activeSchoolIds }, isActive: true },
    });
    if (children.length === 0) return res.json({ drivers: [] });
    const childIds = children.map(c => c.id);
    const routeStudents = await RouteStudent.findAll({ where: { studentId: childIds } });
    const routeIds = [...new Set(routeStudents.map(rs => rs.routeId))];
    const routes = routeIds.length ? await Route.findAll({ where: { id: routeIds, schoolId: { [Op.in]: activeSchoolIds }, isActive: true }, include: [
      { model: User, as: 'driver', where: { role: 'driver', isActive: true }, required: true, attributes: ['id','schoolId','firstName','lastName','phone','email'] },
    ] }) : [];
    const drivers = []; const seen = new Set();
    routes.forEach(r => {
      if (r.driver?.schoolId === r.schoolId && !seen.has(r.driver.id)) {
        seen.add(r.driver.id);
        drivers.push({ id: r.driver.id, firstName: r.driver.firstName, lastName: r.driver.lastName, phone: r.driver.phone, email: r.driver.email, routeName: r.name });
      }
    });
    const trips = await Trip.findAll({
      where: { status: 'in_progress', [Op.or]: children.map(child => ({
        plan: { [Op.contains]: { stops: [{ studentId: child.id, parentId: userId }] } },
      })) },
      include: [
        { model: Route, as: 'route', where: { schoolId: { [Op.in]: activeSchoolIds } }, required: true, attributes: ['id', 'name', 'schoolId'] },
        { model: User, as: 'driver', where: { role: 'driver', isActive: true }, required: true, attributes: ['id', 'schoolId', 'firstName', 'lastName', 'phone', 'email'] },
      ],
    });
    for (const trip of trips) {
      const driver = trip.driver;
      if (!driver || seen.has(driver.id) || driver.schoolId !== trip.route?.schoolId
        || trip.plan?.schoolId !== trip.route.schoolId
        || !trip.plan.stops?.some(stop => stop.parentId === userId
          && children.some(child => child.id === stop.studentId && child.schoolId === driver.schoolId))) continue;
      seen.add(driver.id);
      drivers.push({ id: driver.id, firstName: driver.firstName, lastName: driver.lastName,
        phone: driver.phone, email: driver.email, routeName: trip.plan.routeName || trip.route.name });
    }
    res.json({ drivers });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
// Get system/alert notifications for a user
exports.getNotifications = async (req, res) => {
  try {
    const where = {
      receiverId: req.user.id,
      receiverDeletedAt: null,
      messageType: { [Op.in]: ['alert', 'arrival', 'system'] },
    };
    if (req.user.role === 'parent') {
      where.schoolId = { [Op.in]: await getActiveParentSchoolIds(req.user.id) };
    }
    const msgs = await Message.findAll({
      where,
      include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role'] }],
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    const notifications = msgs.map(msg => {
      const notification = msg.toJSON();
      if (!notification.sender) {
        notification.sender = { id: null, firstName: 'Deleted', lastName: 'user', role: null };
      }
      return notification;
    });
    res.json({ notifications });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findOne({
      where: {
        id: req.params.id,
        [Op.or]: [{ senderId: req.user.id }, { receiverId: req.user.id }],
      },
    });
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    const deletedAt = new Date();
    const updates = {};
    if (message.senderId === req.user.id) updates.senderDeletedAt = deletedAt;
    if (message.receiverId === req.user.id) updates.receiverDeletedAt = deletedAt;
    await message.update(updates);

    res.json({ message: 'Message removed from your account.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.clearThread = async (req, res) => {
  try {
    const partnerId = parseInt(req.params.partnerId, 10);
    if (!Number.isInteger(partnerId)) return res.status(400).json({ error: 'A valid partnerId is required.' });
    const deletedAt = new Date();

    const [sentCount, receivedCount] = await sequelize.transaction(async transaction => Promise.all([
      Message.update(
        { senderDeletedAt: deletedAt },
        { where: { senderId: req.user.id, receiverId: partnerId, senderDeletedAt: null }, transaction }
      ),
      Message.update(
        { receiverDeletedAt: deletedAt },
        { where: { senderId: partnerId, receiverId: req.user.id, receiverDeletedAt: null }, transaction }
      ),
    ]));

    res.json({
      message: 'Conversation cleared from your account.',
      deletedCount: sentCount[0] + receivedCount[0],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteNotification = async (req, res) => {
  try {
    const [updated] = await Message.update(
      { receiverDeletedAt: new Date() },
      {
        where: {
          id: req.params.id,
          receiverId: req.user.id,
          receiverDeletedAt: null,
          messageType: { [Op.in]: ['alert', 'arrival', 'system'] },
        },
      }
    );
    if (!updated) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ message: 'Notification removed.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.clearNotifications = async (req, res) => {
  try {
    const [deletedCount] = await Message.update(
      { receiverDeletedAt: new Date() },
      {
        where: {
          receiverId: req.user.id,
          receiverDeletedAt: null,
          messageType: { [Op.in]: ['alert', 'arrival', 'system'] },
        },
      }
    );
    res.json({ message: 'Notifications cleared.', deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
