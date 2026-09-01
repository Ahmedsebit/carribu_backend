const { Message, User, Trip, Route, Student, School, RouteStudent, sequelize } = require('../models');
const { Op } = require('sequelize');
const { notifyUser } = require('../socket');
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const where = { [Op.or]: [{ senderId: userId }, { receiverId: userId }] };
    if (req.user.role !== 'parent') where.schoolId = req.user.schoolId;
    const messages = await Message.findAll({ where, include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role','phone'] }, { model: User, as: 'receiver', attributes: ['id','firstName','lastName','role','phone'] }], order: [['created_at','DESC']] });
    const map = {};
    messages.forEach(msg => {
      const pid = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!map[pid]) { const p = msg.senderId === userId ? msg.receiver : msg.sender; map[pid] = { partnerId: pid, partnerName: `${p.firstName} ${p.lastName}`, partnerRole: p.role, partnerPhone: p.phone, lastMessage: msg.content, lastMessageTime: msg.createdAt, lastMessageType: msg.messageType, unreadCount: 0 }; }
      if (msg.receiverId === userId && !msg.isRead) map[pid].unreadCount++;
    });
    res.json({ conversations: Object.values(map) });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getThread = async (req, res) => {
  try {
    const userId = req.user.id; const partnerId = parseInt(req.params.partnerId);
    const where = { [Op.or]: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }] };
    if (req.user.role !== 'parent') where.schoolId = req.user.schoolId;
    const messages = await Message.findAll({ where, include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role'] }], order: [['created_at','ASC']], limit: parseInt(req.query.limit) || 50 });
    await Message.update({ isRead: true }, { where: { senderId: partnerId, receiverId: userId, isRead: false } });
    res.json({ messages, total: messages.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.send = async (req, res) => {
  try {
    const { receiverId, content, messageType, tripId } = req.body;
    if (!receiverId || !content) return res.status(400).json({ error: 'receiverId and content required.' });
    const receiverWhere = { id: receiverId };
    if (req.user.role !== 'parent') receiverWhere.schoolId = req.user.schoolId;
    const receiver = await User.findOne({ where: receiverWhere });
    if (!receiver) return res.status(404).json({ error: 'Receiver not found.' });
    const msg = await Message.create({ schoolId: receiver.schoolId || req.user.schoolId, senderId: req.user.id, receiverId, content, messageType: messageType || 'text', tripId: tripId || null });
    const full = await Message.findByPk(msg.id, { include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role'] }, { model: User, as: 'receiver', attributes: ['id','firstName','lastName','role'] }] });
    res.status(201).json({ message: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      attributes: ['id'],
      include: [{
        model: Route,
        as: 'route',
        where: { schoolId: req.user.schoolId },
        required: true,
        attributes: ['id', 'name'],
        include: [{
          model: Student,
          as: 'students',
          where: { isActive: true },
          required: false,
          attributes: ['id', 'parentId'],
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
    trips.forEach(trip => {
      (trip.route?.students || []).forEach(student => {
        if (!student.parent) return;
        const parentTrips = recipients.get(student.parent.id) || new Set();
        parentTrips.add(trip.id);
        recipients.set(student.parent.id, parentTrips);
      });
    });
    if (recipients.size === 0) {
      return res.status(400).json({ error: 'The selected trips do not have any linked parents.' });
    }

    await sequelize.transaction(async transaction => {
      await Message.bulkCreate(
        [...recipients.entries()].map(([parentId, parentTrips]) => ({
          schoolId: req.user.schoolId,
          senderId: req.user.id,
          receiverId: parentId,
          tripId: parentTrips.size === 1 ? [...parentTrips][0] : null,
          content,
          messageType: 'alert',
        })),
        { transaction }
      );
    });

    recipients.forEach((parentTrips, parentId) => {
      notifyUser(parentId, 'school-notification', {
        message: content,
        tripIds: [...parentTrips],
        schoolId: req.user.schoolId,
      });
    });

    res.status(201).json({
      message: `Notification sent to ${recipients.size} ${recipients.size === 1 ? 'parent' : 'parents'}.`,
      recipientCount: recipients.size,
      tripCount: trips.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.reportAbsence = async (req, res) => {
  try {
    const { studentId, studentIds, reason, date } = req.body;
    const ids = studentIds && Array.isArray(studentIds) ? studentIds.map(id => parseInt(id)).filter(Boolean) : studentId ? [parseInt(studentId)] : [];
    if (ids.length === 0) return res.status(400).json({ error: 'studentId or studentIds required.' });
    const students = await Student.findAll({ where: { id: ids }, include: [{ model: Route, as: 'routes', include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName'] }, { model: School, as: 'school', attributes: ['id','name'] }] }] });
    if (students.length === 0) return res.status(404).json({ error: 'Student(s) not found.' });
    const sent = [];
    for (const student of students) {
      for (const route of (student.routes || [])) {
        if (route.driver) {
          const m = await Message.create({
            schoolId: route.schoolId || req.user.schoolId,
            senderId: req.user.id,
            receiverId: route.driver.id,
            content: `⚠️ ABSENCE: ${student.firstName} ${student.lastName} absent on ${date || 'today'}. Reason: ${reason || 'Not specified'}`,
            messageType: 'absence',
          });
          sent.push(m);
        }
      }
    }
    res.status(201).json({ message: `Absence reported to ${sent.length} driver notification(s).`, notifications: sent.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getUnreadCount = async (req, res) => {
  try { const count = await Message.count({ where: { receiverId: req.user.id, isRead: false } }); res.json({ unreadCount: count }); }
  catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getRouteParents = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.routeId, schoolId: req.user.schoolId }, include: [{ model: Student, as: 'students', include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email'] }] }] });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const parents = []; const seen = new Set();
    (route.students || []).forEach(s => { if (s.parent && !seen.has(s.parent.id)) { seen.add(s.parent.id); parents.push({ ...s.parent.toJSON(), children: route.students.filter(st => st.parentId === s.parent.id).map(st => ({ id: st.id, firstName: st.firstName, lastName: st.lastName, grade: st.grade })) }); } });
    res.json({ parents, total: parents.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
// Get drivers assigned to routes that have this parent's children
exports.getMyDrivers = async (req, res) => {
  try {
    const userId = req.user.id;
    const children = await Student.findAll({ where: { parentId: userId, isActive: true } });
    if (children.length === 0) return res.json({ drivers: [] });
    const childIds = children.map(c => c.id);
    const routeStudents = await RouteStudent.findAll({ where: { studentId: childIds } });
    const routeIds = [...new Set(routeStudents.map(rs => rs.routeId))];
    if (routeIds.length === 0) return res.json({ drivers: [] });
    const routes = await Route.findAll({ where: { id: routeIds, isActive: true }, include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName','phone','email'] }] });
    const drivers = []; const seen = new Set();
    routes.forEach(r => {
      if (r.driver && !seen.has(r.driver.id)) {
        seen.add(r.driver.id);
        drivers.push({ id: r.driver.id, firstName: r.driver.firstName, lastName: r.driver.lastName, phone: r.driver.phone, email: r.driver.email, routeName: r.name });
      }
    });
    res.json({ drivers });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
// Get system/alert notifications for a user
exports.getNotifications = async (req, res) => {
  try {
    const msgs = await Message.findAll({
      where: { receiverId: req.user.id, messageType: { [Op.in]: ['alert', 'arrival', 'system'] } },
      include: [{ model: User, as: 'sender', attributes: ['id','firstName','lastName','role'] }],
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    res.json({ notifications: msgs });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
