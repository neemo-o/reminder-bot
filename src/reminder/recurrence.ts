import { RecurrenceRule } from '../types/index.js';

/**
 * Calculates the next trigger timestamp (ms UTC) for a recurring reminder based on its RecurrenceRule.
 */
export function calculateNextTriggerAt(currentTriggerMs: number, recurrence: RecurrenceRule): number {
  const date = new Date(currentTriggerMs);

  switch (recurrence.type) {
    case 'daily': {
      date.setDate(date.getDate() + 1);
      return date.getTime();
    }

    case 'weekly': {
      if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
        // Find next target weekday
        const currentDay = date.getDay(); // 0-6
        let daysToAdd = 1;
        while (daysToAdd <= 7) {
          const nextDay = (currentDay + daysToAdd) % 7;
          if (recurrence.daysOfWeek.includes(nextDay)) {
            break;
          }
          daysToAdd++;
        }
        date.setDate(date.getDate() + daysToAdd);
        return date.getTime();
      } else {
        date.setDate(date.getDate() + 7);
        return date.getTime();
      }
    }

    case 'monthly': {
      const targetDay = recurrence.dayOfMonth || date.getDate();
      const targetYear = date.getFullYear();
      const targetMonth = date.getMonth() + 1;
      const maxDaysInNewMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
      const clampedDay = Math.min(targetDay, maxDaysInNewMonth);
      date.setDate(1);
      date.setMonth(targetMonth);
      date.setDate(clampedDay);
      return date.getTime();
    }

    case 'interval': {
      const intervalMs = recurrence.intervalMs && recurrence.intervalMs > 0 ? recurrence.intervalMs : 3600000;
      return currentTriggerMs + intervalMs;
    }

    default:
      return currentTriggerMs + 24 * 3600 * 1000;
  }
}
