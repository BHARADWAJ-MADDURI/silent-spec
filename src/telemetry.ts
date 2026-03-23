import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type FailureReason =
  | 'provider_error'
  | 'invalid_response'
  | 'no_describe_found'
  | 'healer_removed'
  | 'import_error';

export interface FailureBreakdown {
  provider_error: number;
  invalid_response: number;
  no_describe_found: number;
  healer_removed: number;
  import_error: number;
}

export interface FunctionAttemptRecord {
  attempts: number;
  successes: number;
}

export interface SilentSpecStats {
  totalGenerations: number;
  successfulGenerations: number;
  failedGenerations: number;
  functionsCovered: number;
  estimatedHoursSaved: number;
  testsHealed: number;
  testsHealedSuccessfully: number;
  lastProvider: string;
  lastGeneratedAt: string;
  failureBreakdown: FailureBreakdown;
  functionAttempts: Record<string, FunctionAttemptRecord>;
}

const DEFAULT_FAILURE_BREAKDOWN: FailureBreakdown = {
  provider_error: 0,
  invalid_response: 0,
  no_describe_found: 0,
  healer_removed: 0,
  import_error: 0,
};

const DEFAULT_STATS: SilentSpecStats = {
  totalGenerations: 0,
  successfulGenerations: 0,
  failedGenerations: 0,
  functionsCovered: 0,
  estimatedHoursSaved: 0,
  testsHealed: 0,
  testsHealedSuccessfully: 0,
  lastProvider: 'none',
  lastGeneratedAt: 'none',
  failureBreakdown: { ...DEFAULT_FAILURE_BREAKDOWN },
  functionAttempts: {},
};

export class TelemetryService {
  private readonly statsPath: string;
  private readonly installDate: string;

  constructor(context: vscode.ExtensionContext, installDate: string) {
    this.installDate = installDate;
    this.statsPath = path.join(context.globalStorageUri.fsPath, 'stats.json');
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
      fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }
  }

  getInstallDate(): string {
    return this.installDate;
  }

  getStats(): SilentSpecStats {
    if (!fs.existsSync(this.statsPath)) {
      return { ...DEFAULT_STATS, failureBreakdown: { ...DEFAULT_FAILURE_BREAKDOWN }, functionAttempts: {} };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.statsPath, 'utf8')) as SilentSpecStats;

      // Backfill fields added after initial release
      if (!raw.failureBreakdown) {
        raw.failureBreakdown = { ...DEFAULT_FAILURE_BREAKDOWN };
      } else {
        raw.failureBreakdown = { ...DEFAULT_FAILURE_BREAKDOWN, ...raw.failureBreakdown };
      }
      if (!raw.functionAttempts) { raw.functionAttempts = {}; }
      if (raw.testsHealedSuccessfully === undefined) { raw.testsHealedSuccessfully = 0; }

      // Always recalculate dynamically — never trust stored value
      const grossMinutes = raw.successfulGenerations * 15;
      const repairTax    = raw.failedGenerations * 5;
      raw.estimatedHoursSaved = Number(
        (Math.max(0, grossMinutes - repairTax) / 60).toFixed(1)
      );

      return raw;
    } catch {
      return { ...DEFAULT_STATS, failureBreakdown: { ...DEFAULT_FAILURE_BREAKDOWN }, functionAttempts: {} };
    }
  }

  recordSuccess(
    provider: string,
    coveredFunctions: string[],
    pendingFunctions: string[] = []
  ): void {
    const stats = this.getStats();
    stats.totalGenerations += 1;
    stats.successfulGenerations += 1;
    stats.functionsCovered += coveredFunctions.length;
    stats.lastProvider = provider;
    stats.lastGeneratedAt = new Date().toISOString();

    for (const fn of coveredFunctions) {
      const record = stats.functionAttempts[fn] ?? { attempts: 0, successes: 0 };
      record.attempts += 1;
      record.successes += 1;
      stats.functionAttempts[fn] = record;
    }
    for (const fn of pendingFunctions) {
      const record = stats.functionAttempts[fn] ?? { attempts: 0, successes: 0 };
      record.attempts += 1;
      stats.functionAttempts[fn] = record;
    }

    void this.save(stats);
  }

  recordFailure(provider: string, reason: FailureReason): void {
    const stats = this.getStats();
    stats.totalGenerations += 1;
    stats.failedGenerations += 1;
    stats.failureBreakdown[reason] += 1;
    stats.lastProvider = provider;
    stats.lastGeneratedAt = new Date().toISOString();
    void this.save(stats);
  }

  recordHealing(removedCount: number, healedCount: number = 0): void {
    const stats = this.getStats();
    stats.testsHealed = (stats.testsHealed ?? 0) + removedCount;
    stats.testsHealedSuccessfully = (stats.testsHealedSuccessfully ?? 0) + healedCount;
    stats.failureBreakdown.healer_removed += removedCount;
    void this.save(stats);
  }

  getAvgRetries(): number {
    const stats = this.getStats();
    const records = Object.values(stats.functionAttempts);
    if (records.length === 0) { return 0; }
    const totalAttempts  = records.reduce((sum, r) => sum + r.attempts, 0);
    const totalSuccesses = records.reduce((sum, r) => sum + r.successes, 0);
    if (totalSuccesses === 0) { return 0; }
    return Number((totalAttempts / totalSuccesses).toFixed(2));
  }

  getHealSuccessRate(): number {
    const stats = this.getStats();
    const total = (stats.testsHealed ?? 0) + (stats.testsHealedSuccessfully ?? 0);
    if (total === 0) { return 100; }
    return Math.round(((stats.testsHealedSuccessfully ?? 0) / total) * 100);
  }

  getProblematicFunctions(topN: number = 5): Array<{ fn: string; attempts: number; successRate: number }> {
    const stats = this.getStats();
    return Object.entries(stats.functionAttempts)
      .map(([fn, record]) => ({
        fn,
        attempts: record.attempts,
        successRate: record.attempts > 0
          ? Math.round((record.successes / record.attempts) * 100)
          : 0,
      }))
      .filter(entry => entry.attempts > 1)
      .sort((a, b) => a.successRate - b.successRate || b.attempts - a.attempts)
      .slice(0, topN);
  }

  getFailureSummary(): string {
    const stats = this.getStats();
    if (stats.failedGenerations === 0) { return 'No failures recorded'; }
    const entries = Object.entries(stats.failureBreakdown) as [FailureReason, number][];
    const top = entries.filter(([, count]) => count > 0).sort(([, a], [, b]) => b - a);
    if (top.length === 0) { return 'No failure breakdown available'; }
    return top.map(([reason, count]) => `${reason}: ${count}`).join(', ');
  }

  // Async write — never blocks the event loop.
  // Fire-and-forget: telemetry failure must never break generation.
  private async save(stats: SilentSpecStats): Promise<void> {
    try {
      await fs.promises.writeFile(
        this.statsPath,
        JSON.stringify(stats, null, 2),
        'utf8'
      );
    } catch {
      // Non-fatal
    }
  }
}