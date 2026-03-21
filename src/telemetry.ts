import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface SilentSpecStats {
  totalGenerations: number;
  successfulGenerations: number;
  failedGenerations: number;
  functionsCovered: number;
  estimatedHoursSaved: number;
  testsHealed: number;
  lastProvider: string;
  lastGeneratedAt: string;
}

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
      return {
        totalGenerations: 0,
        successfulGenerations: 0,
        failedGenerations: 0,
        functionsCovered: 0,
        estimatedHoursSaved: 0,
        testsHealed: 0,
        lastProvider: 'none',
        lastGeneratedAt: 'none',
      };
    }
    try {
      const stats = JSON.parse(fs.readFileSync(this.statsPath, 'utf8')) as SilentSpecStats;
      // Always recalculate from functionsCovered to reflect any formula changes
      const grossMinutes = stats.successfulGenerations * 15;
      const repairTax = stats.failedGenerations * 5;
      stats.estimatedHoursSaved = Number((Math.max(0, grossMinutes - repairTax) / 60).toFixed(1));
      return stats;
    } catch {
      // Corrupted stats file — reset silently
      return {
        totalGenerations: 0,
        successfulGenerations: 0,
        failedGenerations: 0,
        functionsCovered: 0,
        estimatedHoursSaved: 0,
        testsHealed: 0,
        lastProvider: 'none',
        lastGeneratedAt: 'none',
      };
    }
  }

  recordSuccess(provider: string, functionCount: number): void {
    const stats = this.getStats();
    stats.totalGenerations += 1;
    stats.successfulGenerations += 1;
    // Math.max(1) ensures hours saved never stays at 0 if regex misses describe blocks
    stats.functionsCovered += Math.max(1, functionCount);
    // 5 minutes per function — industry average, clearly labeled as estimate
    const grossMinutes = stats.successfulGenerations * 15;
    const repairTax = stats.failedGenerations * 5;
    const netMinutes = Math.max(0, grossMinutes - repairTax);
    stats.estimatedHoursSaved = Number((netMinutes / 60).toFixed(1));
    stats.lastProvider = provider;
    stats.lastGeneratedAt = new Date().toISOString();
    this.save(stats);
  }

  recordFailure(provider: string): void {
    const stats = this.getStats();
    stats.totalGenerations += 1;
    stats.failedGenerations += 1;
    stats.lastProvider = provider;
    stats.lastGeneratedAt = new Date().toISOString();
    this.save(stats);
  }

  recordHealing(count: number): void {
    const stats = this.getStats();
    stats.testsHealed = (stats.testsHealed ?? 0) + count;
    this.save(stats);
  }

  private save(stats: SilentSpecStats): void {
    try {
      fs.writeFileSync(this.statsPath, JSON.stringify(stats, null, 2), 'utf8');
    } catch {
      // Non-fatal — telemetry failure must never break generation
    }
  }
}