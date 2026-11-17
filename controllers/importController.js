const path = require('path');
const { StudentImport, User } = require('../models');
const { planImport, confirmImport, fail } = require('../services/studentImport');

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const respondError = (res, error) => res.status(error.status || 500).json({
  error: error.status ? error.message : 'The import could not be processed. Please try again.',
  stage: error.stage || 'import',
});
const publicRecord = record => {
  const data = record.toJSON();
  delete data.fileData;
  return data;
};

exports.previewImport = async (req, res) => {
  try {
    const plan = await planImport(req.file, req.user.schoolId);
    const uploader = await User.findByPk(req.user.id, { attributes: ['firstName', 'lastName'] });
    const filename = path.win32.basename(path.basename(req.file.originalname)).replace(/[\x00-\x1f\x7f]/g, '').slice(-255);
    const record = await StudentImport.create({
      ...plan, schoolId: req.user.schoolId, uploadedBy: req.user.id,
      uploaderName: `${uploader.firstName} ${uploader.lastName}`,
      filename, fileData: req.file.buffer,
    });
    res.json(publicRecord(record));
  } catch (error) { respondError(res, error); }
};

exports.importParentsAndStudents = async (req, res) => {
  try {
    if (!validId(req.body?.importId)) throw fail('Validate and preview a file before confirming the import.', 'import');
    const record = await confirmImport(req.body.importId, req.user);
    res.json({
      ...publicRecord(record),
      message: `Import complete: ${record.counts.studentsCreated} students created, ${record.counts.studentsUpdated} updated, ${record.counts.errorRows} rows with errors.`,
    });
  } catch (error) { respondError(res, error); }
};

exports.getHistory = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const { rows, count } = await StudentImport.findAndCountAll({
      where: { schoolId: req.user.schoolId },
      attributes: { exclude: ['fileData', 'rows'] },
      order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 20, offset: (page - 1) * 20,
    });
    res.json({ imports: rows, total: count, page, pageSize: 20 });
  } catch (error) { respondError(res, error); }
};

exports.getRecord = async (req, res) => {
  try {
    if (!validId(req.params.id)) throw fail('Upload record not found.', 'import', 404);
    const record = await StudentImport.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!record) throw fail('Upload record not found.', 'import', 404);
    res.json(publicRecord(record));
  } catch (error) { respondError(res, error); }
};

exports.downloadFile = async (req, res) => {
  try {
    if (!validId(req.params.id)) throw fail('Upload record not found.', 'import', 404);
    const record = await StudentImport.unscoped().findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      attributes: ['filename', 'contentType', 'fileData'],
    });
    if (!record) throw fail('Upload record not found.', 'import', 404);
    res.set('Cache-Control', 'no-store');
    res.attachment(record.filename).type(record.contentType).send(record.fileData);
  } catch (error) { respondError(res, error); }
};
