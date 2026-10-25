import express from 'express';
import { body, param } from 'express-validator';
import auth = require('../middleware/auth');
import { accessTokenLimiter } from '../middleware/rateLimiter';
import accessTokenController = require('../controllers/accessTokenController');

const router = express.Router();

// Before auth, so a 401 is not cached either: a response here may carry a
// token that is shown once, and no proxy or browser cache should keep it.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Apply auth middleware to all routes
router.use(auth);

// The password is re-checked in the service. It is not trimmed: a password is
// exactly what was typed. The cap keeps a huge body from being hashed at all
// (bcrypt reads only the first 72 bytes).
const createValidation = [
  body('name').isString().withMessage('name is required').bail()
    .trim().isLength({ min: 1, max: 60 }).withMessage('name must be 1-60 characters'),
  body('password').isString().withMessage('password is required').bail()
    .notEmpty().withMessage('password is required')
    .isLength({ max: 1024 }).withMessage('password is too long'),
];

const idValidation = [
  param('id').isInt({ min: 1, max: 2147483647 }).withMessage('id must be a positive whole number'),
];

router.get('/', accessTokenController.list);
// Limiter after auth: it is keyed on the user.
router.post('/', accessTokenLimiter, createValidation, accessTokenController.create);
router.delete('/:id', accessTokenLimiter, idValidation, accessTokenController.revoke);

export = router;
