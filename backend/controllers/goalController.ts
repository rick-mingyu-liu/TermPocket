import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { query } from '../db/connection';
import { getExchangeRate } from '../services/exchangeRateService';
import type { SavingsGoalRow } from '../types/db';
import { isDemoAccount, CLEAR_DEMO_REFUSAL } from '../services/demoGuard';

/** SELECT id FROM savings_goals — the ownership check before an update/delete. */
interface GoalIdRow {
  id: number;
}

/** A savings_goals row, plus the amounts converted to the caller's requested currency. */
interface GoalWithConversion extends SavingsGoalRow {
  convertedCurrentAmount?: number;
  convertedTargetAmount?: number;
  convertedCurrency?: string;
}

const goalController = {
  // Get all goals for user
  async getGoals(req: Request, res: Response) {
    try {
      // req.query is unvalidated here, as it always has been: a non-string
      // value would already have broken getExchangeRate below at runtime.
      const targetCurrency = req.query.targetCurrency as string | undefined;
      const goals = await query<SavingsGoalRow>(
        'SELECT * FROM savings_goals WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.userId]
      );
      const resultGoals: GoalWithConversion[] = goals.rows;
      if (targetCurrency) {
        // Convert each goal's amounts to target currency if needed
        const rateCache: Record<string, number> = {};
        for (const goal of resultGoals) {
          // current_amount can be null; parseFloat coerces its argument to a
          // string internally, so String(...) here matches parseFloat(null)'s
          // existing NaN rather than silently defaulting to 0.
          let convertedCurrent = parseFloat(String(goal.current_amount));
          let convertedTarget = parseFloat(goal.target_amount);
          let convertedCurrency = goal.currency;
          if (goal.currency && goal.currency !== targetCurrency) {
            const cacheKey = `${goal.currency}_${targetCurrency}`;
            let rate = rateCache[cacheKey];
            if (!rate) {
              rate = await getExchangeRate(goal.currency, targetCurrency);
              rateCache[cacheKey] = rate;
            }
            convertedCurrent = convertedCurrent * rate;
            convertedTarget = convertedTarget * rate;
            convertedCurrency = targetCurrency;
          }
          goal.convertedCurrentAmount = convertedCurrent;
          goal.convertedTargetAmount = convertedTarget;
          goal.convertedCurrency = convertedCurrency;
        }
      }
      res.json({ goals: resultGoals });

    } catch (error) {
      console.error('Get goals error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Create new goal
  async createGoal(req: Request, res: Response) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, target_amount, current_amount, target_date, description, currency } = req.body;

      const newGoal = await query<SavingsGoalRow>(
        'INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date, description, currency) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [req.user.userId, name, target_amount, current_amount || 0, target_date, description, currency || 'CAD']
      );

      res.status(201).json({
        message: 'Goal created successfully',
        goal: newGoal.rows[0]
      });

    } catch (error) {
      console.error('Create goal error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Update goal
  async updateGoal(req: Request, res: Response) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { name, target_amount, current_amount, target_date, description, currency } = req.body;

      // Check if goal belongs to user
      const existingGoal = await query<GoalIdRow>(
        'SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      if (existingGoal.rows.length === 0) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      const updatedGoal = await query<SavingsGoalRow>(
        'UPDATE savings_goals SET name = $1, target_amount = $2, current_amount = $3, target_date = $4, description = $5, currency = $6 WHERE id = $7 AND user_id = $8 RETURNING *',
        [name, target_amount, current_amount, target_date, description, currency || 'CAD', id, req.user.userId]
      );

      res.json({
        message: 'Goal updated successfully',
        goal: updatedGoal.rows[0]
      });

    } catch (error) {
      console.error('Update goal error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Delete goal
  async deleteGoal(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Check if goal belongs to user
      const existingGoal = await query<GoalIdRow>(
        'SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      if (existingGoal.rows.length === 0) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      await query(
        'DELETE FROM savings_goals WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      res.json({ message: 'Goal deleted successfully' });

    } catch (error) {
      console.error('Delete goal error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Update goal progress
  async updateProgress(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { current_amount } = req.body;

      // Check if goal belongs to user
      const existingGoal = await query<GoalIdRow>(
        'SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      if (existingGoal.rows.length === 0) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      const updatedGoal = await query<SavingsGoalRow>(
        'UPDATE savings_goals SET current_amount = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
        [current_amount, id, req.user.userId]
      );

      res.json({
        message: 'Goal progress updated successfully',
        goal: updatedGoal.rows[0]
      });

    } catch (error) {
      console.error('Update progress error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Get goal statistics
  async getGoalStats(req: Request, res: Response) {
    try {
      const goals = await query<SavingsGoalRow>(
        'SELECT * FROM savings_goals WHERE user_id = $1',
        [req.user.userId]
      );

      const stats = {
        totalGoals: goals.rows.length,
        completedGoals: 0,
        totalTargetAmount: 0,
        totalCurrentAmount: 0,
        averageProgress: 0,
        goals: goals.rows
      };

      goals.rows.forEach(goal => {
        stats.totalTargetAmount += parseFloat(goal.target_amount);
        stats.totalCurrentAmount += parseFloat(String(goal.current_amount));

        if (parseFloat(String(goal.current_amount)) >= parseFloat(goal.target_amount)) {
          stats.completedGoals += 1;
        }
      });

      if (stats.totalTargetAmount > 0) {
        stats.averageProgress = (stats.totalCurrentAmount / stats.totalTargetAmount) * 100;
      }

      res.json(stats);

    } catch (error) {
      console.error('Get goal stats error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Settings -> Clear All Data. Refused for the shared demo account.
  async clearAllGoals(req: Request, res: Response) {
    try {
      if (await isDemoAccount(req.user.userId)) return res.status(403).json(CLEAR_DEMO_REFUSAL);

      await query(
        'DELETE FROM savings_goals WHERE user_id = $1',
        [req.user.userId]
      );

      res.json({ message: 'All goals cleared successfully' });

    } catch (error) {
      console.error('Clear goals error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
};

export = goalController;
