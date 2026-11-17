const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');
const controller = require('../controllers/importController');
const { MAX_BYTES } = require('../services/studentImport');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 0 },
  fileFilter: (req, file, cb) => {
    if (['.csv', '.xls', '.xlsx'].includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new Error('Only .csv, .xls and .xlsx files are supported.'));
  },
});

router.use(authenticate, authorize('school_admin', 'coordinator'), schoolTenancy);
router.use((req, res, next) => {
  if (!Number.isInteger(req.user.schoolId) || req.user.schoolId <= 0) {
    return res.status(403).json({ error: 'An active school is required.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});
/**
 * @swagger
 * tags:
 *   name: Import
 *   description: School-scoped CSV/Excel student previews and upload history
 * /api/import/preview:
 *   post:
 *     summary: Validate a CSV/Excel file and save a preview without changing students
 *     tags: [Import]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Saved preview ID, row actions/errors and counts
 *       400:
 *         description: Invalid file or columns, with validation stage
 * /api/import/parents-students:
 *   post:
 *     summary: Confirm a saved preview, skipping error rows
 *     tags: [Import]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [importId]
 *             properties:
 *               importId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Persisted row results and created, updated, error and unchanged counts
 * /api/import/history:
 *   get:
 *     summary: List upload history for the current school
 *     tags: [Import]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Upload metadata and counts, 20 records per page
 * /api/import/{id}:
 *   get:
 *     summary: View saved preview or completed import rows
 *     tags: [Import]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Upload metadata, row results and counts
 * /api/import/{id}/download:
 *   get:
 *     summary: Download the original file from a school-scoped upload record
 *     tags: [Import]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Original uploaded file as an attachment
 */
router.post('/preview', (req, res, next) => upload.single('file')(req, res, error => {
  if (error) return res.status(400).json({
    error: error.code === 'LIMIT_FILE_SIZE' ? 'The file must be no larger than 5 MB.' : error.message,
    stage: 'file',
  });
  next();
}), controller.previewImport);
router.post('/parents-students', controller.importParentsAndStudents);
router.get('/history', controller.getHistory);
router.get('/:id/download', controller.downloadFile);
router.get('/:id', controller.getRecord);

module.exports = router;
