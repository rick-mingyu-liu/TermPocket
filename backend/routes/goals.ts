import express from 'express';
import { body } from 'express-validator';
import goalController = require('../controllers/goalController');
import auth = require('../middleware/auth');

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'CNY'];

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);

// Validation middleware
const goalValidation = [
  body('name').notEmpty().withMessage('Goal name is required'),
  body('target_amount').isFloat({ min: 0.01 }).withMessage('Target amount must be a positive number'),
  body('current_amount').optional().isFloat({ min: 0 }).withMessage('Current amount must be a non-negative number'),
  body('target_date').isISO8601().withMessage('Target date is required and must be a valid date'),
  // Optional (the controller defaults to CAD), but never another value: the
  // database refuses one (migration 018) and the converter cannot price it.
  body('currency').optional().isIn(CURRENCIES).withMessage('Currency must be one of CAD, USD, EUR, GBP, AUD, CNY')
];

const progressValidation = [
  body('current_amount').isFloat({ min: 0 }).withMessage('Current amount must be a non-negative number')
];

// Routes
router.get('/', goalController.getGoals);
router.post('/', goalValidation, goalController.createGoal);
router.get('/stats', goalController.getGoalStats);
router.delete('/clear-all', goalController.clearAllGoals);
router.put('/:id', goalValidation, goalController.updateGoal);
router.delete('/:id', goalController.deleteGoal);
router.put('/:id/progress', progressValidation, goalController.updateProgress);

export = router;
