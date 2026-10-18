import { logger } from '../lib/misc';
import { runCallbackReminders } from './callbacks';
import { runInstallmentReminders } from '../services/installments';
import { runCleanAlerts, runConsentAlerts } from './procedureSla';
import { runAutoSendToReception } from '../modules/procedures/service';
import { runOfficeRounds } from '../modules/office/service';
import { runStockAlerts } from '../modules/inventory/stock';
import { runProcedureDayRelease, runProcedureReminders } from './procedureDay';

/**
 * Job registry and periodic watchers (spec §23). Watchers are idempotent scans run every worker tick; each unit of
 * work is claimed with a deterministic key, so several workers or overlapping ticks never duplicate anything.
 * The Google Sheets lead sync runs on its own loop in worker.ts.
 */
export function registerAllJobs(): void {
  // DB-queued job handlers are registered here as phases add them.
}

const WATCHERS: { name: string; run: (now: Date) => Promise<number> }[] = [
  { name: 'callbackReminders', run: runCallbackReminders },
  { name: 'installmentReminders', run: runInstallmentReminders },
  { name: 'consentSla', run: runConsentAlerts },
  { name: 'roomCleanSla', run: runCleanAlerts },
  { name: 'autoSendToReception', run: runAutoSendToReception },
  { name: 'officeRounds', run: runOfficeRounds },
  { name: 'stockAlerts', run: runStockAlerts },
  { name: 'procedureReminders', run: runProcedureReminders },
  { name: 'procedureDayRelease', run: runProcedureDayRelease },
];

export async function runWatchersOnce(now: Date): Promise<void> {
  for (const w of WATCHERS) {
    try {
      const n = await w.run(now);
      if (n) logger.info({ watcher: w.name, n }, 'watcher processed items');
    } catch (err) {
      logger.error({ err, watcher: w.name }, 'watcher failed');
    }
  }
}
