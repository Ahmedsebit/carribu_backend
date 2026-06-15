const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');
const importController = require('../controllers/importController');

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

router.use(authenticate);
router.use(authorize('school_admin', 'coordinator'));

/**
 * @swagger
 * tags:
 *   name: Import
 *   description: Bulk import parents and students from CSV
 */

/**
 * @swagger
 * /api/import/preview:
 *   post:
 *     summary: Preview CSV import without saving
 *     tags: [Import]
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Preview of parsed data
 */
router.post('/preview', upload.single('file'), importController.previewImport);

/**
 * @swagger
 * /api/import/parents-students:
 *   post:
 *     summary: Bulk import parents and students from CSV
 *     tags: [Import]
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Import results
 */
router.post('/parents-students', upload.single('file'), importController.importParentsAndStudents);

module.exports = router;
