const { Message, User, Trip, Route, Student, School } = require('../models');
const { Op } = require('sequelize');
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
