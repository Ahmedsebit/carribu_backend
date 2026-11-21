const crypto = require('crypto');
const { sequelize, User, ParentSchool, ParentActivationInvitation } = require('../models');
const { normalizePhoneE164 } = require('../utils/phone');

const fail = (status, message) => Object.assign(new Error(message), { status });
const invalidInvitation = () => fail(403, 'The invitation is invalid or expired. Contact your school for a new activation code.');
const hashCode = code => {
  if (typeof code !== 'string' || code.length > 100) throw invalidInvitation();
  const normalized = code.replace(/[-\s]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw invalidInvitation();
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

async function issueInvitation(parentId, issuer) {
  const id = Number(parentId);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'A valid parent ID is required.');
  if (!['school_admin', 'coordinator'].includes(issuer.role)) throw fail(403, 'Only school staff can issue activation invitations.');
  return sequelize.transaction(async transaction => {
    const currentIssuer = await User.findByPk(issuer.id, {
      attributes: ['id', 'role', 'schoolId', 'isActive'], transaction, lock: transaction.LOCK.SHARE,
    });
    if (!currentIssuer?.isActive || !['school_admin', 'coordinator'].includes(currentIssuer.role)
      || currentIssuer.schoolId !== issuer.schoolId) throw fail(403, 'Your school invitation access is no longer active.');
    const parent = await User.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    const membership = await ParentSchool.findOne({
      where: { parentId: id, schoolId: issuer.schoolId, isActive: true }, transaction,
    });
    if (!parent || parent.role !== 'parent' || !parent.isActive || !membership) throw fail(404, 'Parent not found.');
    if (!parent.mustSetPassword) throw fail(409, 'This parent has already activated their account.');
    const code = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    await ParentActivationInvitation.update({ consumedAt: now }, {
      where: { parentId: id, consumedAt: null }, transaction,
    });
    await ParentActivationInvitation.create({
      parentId: id, schoolId: issuer.schoolId, issuedById: issuer.id,
      codeHash: hashCode(code), expiresAt,
    }, { transaction });
    return { code: code.match(/.{4}/g).join('-'), expiresAt };
  });
}

async function verifyInvitation(phoneValue, code, transaction) {
  const phone = normalizePhoneE164(phoneValue);
  const codeHash = hashCode(code);
  if (!phone) throw invalidInvitation();
  const candidate = await ParentActivationInvitation.findOne({ where: { codeHash, consumedAt: null }, transaction });
  if (!candidate) throw invalidInvitation();
  const user = await User.findOne({
    where: { id: candidate.parentId, phone, role: 'parent', mustSetPassword: true, isActive: true },
    transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!user) throw invalidInvitation();
  const invitation = await ParentActivationInvitation.findOne({
    where: { parentId: user.id, codeHash, consumedAt: null },
    transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const expires = new Date(invitation?.expiresAt).getTime();
  if (!invitation || !Number.isFinite(expires) || expires <= Date.now()) throw invalidInvitation();
  const membership = await ParentSchool.findOne({
    where: { parentId: user.id, schoolId: invitation.schoolId, isActive: true }, transaction,
  });
  if (!membership) throw invalidInvitation();
  return { user, invitation };
}

async function activateParent(phone, code, newPassword) {
  return sequelize.transaction(async transaction => {
    const { user, invitation } = await verifyInvitation(phone, code, transaction);
    user.passwordHash = newPassword;
    user.mustSetPassword = false;
    user.authVersion = (user.authVersion || 0) + 1;
    user.expoPushToken = null;
    user.fcmPushToken = null;
    await user.save({ transaction });
    await invitation.update({ consumedAt: new Date() }, { transaction });
    return user;
  });
}

module.exports = { issueInvitation, verifyInvitation, activateParent };
