import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface SilentSpecStats {
  totalGenerations: number;
  successfulGenerations: number;
  failedGenerations: number;
  functionsCovered: number;
  estimatedHoursSaved: number;
  lastProvider: string;
  lastGeneratedAt: string;
}

export class TelemetryService {
  private readonly statsPath: string;

  constructor(context: vscode.ExtensionContext) {
    this.statsPath = path.join(context.globalStorageUri.fsPath, 'stats.json');
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
      fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }
  }

  getStats(): SilentSpecStats {
    if (!fs.existsSync(this.statsPath)) {
      return {
        totalGenerations: 0,
        successfulGenerations: 0,
        failedGenerations: 0,
        functionsCovered: 0,
        estimatedHoursSaved: 0,
        lastProvider: 'none',
        lastGeneratedAt: 'none',
      };
    }
    try {
      return JSON.parse(fs.readFileSync(this.statsPath, 'utf8')) as SilentSpecStats;
    } catch {
      // Corrupted stats file — reset silently
      return {
        totalGenerations: 0,
        successfulGenerations: 0,
        failedGenerations: 0,
        functionsCovered: 0,
        estimatedHoursSaved: 0,
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
    stats.estimatedHoursSaved = Number(
      (stats.functionsCovered * 5 / 60).toFixed(1)
    );
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

  private save(stats: SilentSpecStats): void {
    try {
      fs.writeFileSync(this.statsPath, JSON.stringify(stats, null, 2), 'utf8');
    } catch {
      // Non-fatal — telemetry failure must never break generation
    }
  }
}