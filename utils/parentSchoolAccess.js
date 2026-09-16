const { ParentSchool } = require('../models');
const { Op } = require('sequelize');

const getActiveParentSchoolIds = async (parentId, transaction) => {
  const memberships = await ParentSchool.findAll({
    where: { parentId, isActive: true },
    attributes: ['schoolId'],
    transaction,
  });
  return memberships.map(membership => membership.schoolId);
};

const hasActiveParentSchool = async (parentId, schoolId, transaction) => {
  if (!schoolId) return false;
  const membership = await ParentSchool.findOne({
    where: { parentId, schoolId, isActive: true },
    attributes: ['id'],
    transaction,
  });
  return Boolean(membership);
};

const getActiveParentIdsForSchool = async (parentIds, schoolId, transaction) => {
  const uniqueIds = [...new Set(parentIds.filter(Boolean))];
  if (uniqueIds.length === 0 || !schoolId) return new Set();
  const memberships = await ParentSchool.findAll({
    where: {
      parentId: { [Op.in]: uniqueIds },
      schoolId,
      isActive: true,
    },
    attributes: ['parentId'],
    transaction,
  });
  return new Set(memberships.map(membership => membership.parentId));
};

module.exports = {
  getActiveParentSchoolIds,
  hasActiveParentSchool,
  getActiveParentIdsForSchool,
};
