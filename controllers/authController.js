const jwt = require('jsonwebtoken');
const { User, School, sequelize } = require('../models');
const { Op } = require('sequelize');
const parentSchoolsInclude = {
  model: School,
  as: 'parentSchools',
  attributes: ['id', 'name'],
  through: { attributes: [], where: { isActive: true } },
};
const { logLogin } = require('../middleware/auditLog');
const { normalizePhoneE164 } = require('../utils/phone');
const { verifyInvitation, activateParent } = require('../services/parentActivation');
const generateToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, schoolId: user.schoolId, authVersion: user.authVersion || 0 },
  process.env.JWT_SECRET || 'default-secret', { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);
const hideInactivePrimarySchool = user => {
  if (user?.role !== 'parent' || !user.school) return user;
  const activeSchoolIds = new Set((user.parentSchools || []).map(school => school.id));
  if (!activeSchoolIds.has(user.school.id)) user.setDataValue('school', null);
  return user;
};
exports.register = async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, phone, schoolId } = req.body;
    if (role !== undefined && role !== 'parent') {
      return res.status(403).json({ error: 'Privileged accounts must be created by an authorised administrator.' });
    }
    if (schoolId != null) {
      return res.status(403).json({ error: 'School enrollment must be arranged by an authorised administrator.' });
    }
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email is required.' });
    const normalizedPhone = phone == null ? null : normalizePhoneE164(phone);
    if (phone != null && !normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required.' });
    if (await User.findOne({ where: { schoolId: null, email: normalizedEmail } })) {
      return res.status(400).json({ error: 'Email already registered for this school.' });
    }
    const user = await User.create({ email: normalizedEmail, passwordHash: password, firstName, lastName,
      role: 'parent', phone: normalizedPhone, schoolId: null, mustSetPassword: true });
    res.status(201).json({
      message: 'Account created. Your school must arrange enrollment and provide an activation code before you can sign in.',
      user,
    });
  } catch (err) { res.status(500).json({ error: 'Registration failed.', details: err.message }); }
};
exports.login = async (req, res) => {
  try {
    const { email, username, password, schoolId } = req.body;
    const loginIdentifier = email || username;
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'email/username and password are required.' });
    }
    // Allow login by email or phone number (in any format)
    const { Op } = require('sequelize');
    const normalizedPhone = normalizePhoneE164(loginIdentifier);
    const normalizedEmail = loginIdentifier.trim().toLowerCase();
    const orConditions = [{ email: normalizedEmail }, { phone: loginIdentifier }];
    if (normalizedPhone) orConditions.push({ phone: normalizedPhone });
    const where = { [Op.or]: orConditions };
    if (schoolId) where.schoolId = schoolId;
    const candidates = await User.findAll({
      where,
      include: [
        { model: School, as: 'school', attributes: ['id','name'] },
        parentSchoolsInclude,
      ],
    });
    const matchingUsers = [];
    for (const candidate of candidates) {
      if (await candidate.validPassword(password)) matchingUsers.push(candidate);
    }
    if (matchingUsers.length === 0) {
      await logLogin(null, loginIdentifier, req.ip, false);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (matchingUsers.length > 1) {
      await logLogin(null, loginIdentifier, req.ip, false);
      return res.status(409).json({ error: 'Multiple accounts match these credentials. Please provide your school ID.' });
    }
    const user = matchingUsers[0];
    if (!user.isActive) return res.status(403).json({ error: 'Account deactivated.' });
    if (user.role === 'parent' && user.mustSetPassword) {
      return res.status(403).json({ error: 'Activate your account using the invitation code provided by your school.' });
    }
    hideInactivePrimarySchool(user);
    await logLogin(user.id, loginIdentifier, req.ip, true);
    res.json({ message: 'Login successful.', token: generateToken(user), user });
  } catch (err) { res.status(500).json({ error: 'Login failed.', details: err.message }); }
};
exports.getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      include: [
        { model: School, as: 'school', attributes: ['id','name'] },
        parentSchoolsInclude,
      ],
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    hideInactivePrimarySchool(user);
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// Reveal pending account details only after validating the school's invitation.
exports.registrationStatus = async (req, res) => {
  try {
    const { user } = await verifyInvitation(req.body.phone, req.body.invitationCode);
    res.json({ found: true, firstName: user.firstName });
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not verify invitation.' }); }
};

// Public: a parent completes their registration by setting their own password
exports.completeRegistration = async (req, res) => {
  try {
    const { newPassword, phone, invitationCode } = req.body;
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
    }
    const user = await activateParent(phone, invitationCode, newPassword);

    const registeredUser = await User.findByPk(user.id, {
      include: [
        { model: School, as: 'school', attributes: ['id','name'] },
        parentSchoolsInclude,
      ],
    });
    hideInactivePrimarySchool(registeredUser);
    res.json({ message: 'Registration complete.', token: generateToken(user), user: registeredUser });
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not complete registration.' }); }
};
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!(await user.validPassword(currentPassword))) return res.status(401).json({ error: 'Current password is incorrect.' });
    user.passwordHash = newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully.' });
  } catch (err) { res.status(500).json({ error: 'Password change failed.', details: err.message }); }
};
exports.updateProfile = async (req, res) => {
  try {
    const { phone, pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng } = req.body;
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (phone !== undefined) user.phone = phone;
    const pickupLocationChanged = [pickupAddress, pickupLat, pickupLng].some(value => value !== undefined);
    if (pickupLocationChanged) {
      if (pickupAddress === undefined || pickupLat === undefined || pickupLng === undefined) {
        return res.status(400).json({ error: 'pickupAddress, pickupLat, and pickupLng are all required.' });
      }
      const lat = Number(pickupLat);
      const lng = Number(pickupLng);
      if (!String(pickupAddress).trim() || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'A valid pickup address, latitude, and longitude are required.' });
      }
      if (user.role === 'parent') {
        user.pendingPickupAddress = String(pickupAddress).trim();
        user.pendingPickupLat = lat;
        user.pendingPickupLng = lng;
        user.pendingPickupRequestedAt = new Date();
      } else {
        user.pickupAddress = String(pickupAddress).trim();
        user.pickupLat = lat;
        user.pickupLng = lng;
      }
    }
    if (dropoffAddress !== undefined) user.dropoffAddress = dropoffAddress;
    if (dropoffLat !== undefined) user.dropoffLat = dropoffLat;
    if (dropoffLng !== undefined) user.dropoffLng = dropoffLng;
    await user.save();
    const updated = await User.findByPk(user.id, {
      attributes: { exclude: ['passwordHash'] },
      include: [
        { model: School, as: 'school', attributes: ['id','name'] },
        parentSchoolsInclude,
      ],
    });
    hideInactivePrimarySchool(updated);
    res.json({
      user: updated,
      message: pickupLocationChanged && user.role === 'parent'
        ? 'Pickup location submitted for school approval.'
        : 'Profile updated.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.savePushToken = async (req, res) => {
  try {
    const { pushToken, provider = 'expo' } = req.body;
    if (!['expo', 'fcm'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be either expo or fcm.' });
    }
    if (pushToken !== null && pushToken !== undefined && typeof pushToken !== 'string') {
      return res.status(400).json({ error: 'pushToken must be a string or null.' });
    }
    const field = provider === 'fcm' ? 'fcmPushToken' : 'expoPushToken';
    const token = pushToken?.trim() || null;
    await sequelize.transaction(async transaction => {
      if (token) {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
          replacements: { key: `push:${provider}:${token}` }, transaction,
        });
        await User.update({ [field]: null }, {
          where: { [field]: token, id: { [Op.ne]: req.user.id } }, transaction,
        });
      }
      const user = await User.findByPk(req.user.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!user?.isActive) throw Object.assign(new Error('User not found.'), { status: 404 });
      if ((user.authVersion || 0) !== req.user.authVersion || user.role === 'parent' && user.mustSetPassword) {
        throw Object.assign(new Error('This session is no longer valid.'), { status: 401 });
      }
      user[field] = token;
      await user.save({ transaction });
    });
    res.json({ message: `${provider.toUpperCase()} push token saved.` });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
