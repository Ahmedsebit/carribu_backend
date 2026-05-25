const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const parentController = require('../controllers/parentController');

router.use(authenticate);
router.use(authorize('admin', 'coordinator'));

router.get('/', parentController.listParents);
router.get('/:id', parentController.getParent);
router.post('/', parentController.createParent);
router.put('/:id', parentController.updateParent);
router.delete('/:id', parentController.deleteParent);

module.exports = router;
