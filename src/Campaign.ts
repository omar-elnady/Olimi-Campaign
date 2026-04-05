import { DateTime } from "luxon";
import {
  CampaignConfig,
  CallHandler,
  IClock,
  ICampaign,
  CampaignStatus,
  CallResult,
} from "../interfaces";
import { logger } from "./utils/logger";
import { normalizeAndValidateConfig } from "./validator";

interface PendingRetry {
  phoneNumber: string;
  attempts: number;
  eligibleAtMs: number;
  retrySeq: number;
}

export class Campaign implements ICampaign {
  private config: CampaignConfig;
  private state: "idle" | "running" | "paused" | "completed" = "idle";
  private queue: string[];
  private pendingRetries: PendingRetry[] = [];
  
  private activeCallStartTimes = new Map<string, number>();
  
  private successCount = 0;
  private failedCount = 0;
  private retrySeqCounter = 0;

  private currentTrackingDay = "";
  private dailyDurationMs = 0;

  private scheduledTimerId: number | null = null;
  private tickInProgress = false;
  private needsReTick = false;

  constructor(
    rawConfig: CampaignConfig,
    private callHandler: CallHandler,
    private clock: IClock,
  ) {
    this.config = normalizeAndValidateConfig(rawConfig);
    this.queue = [...this.config.customerList];
  }

  public async start(): Promise<void> {
    if (this.state !== "idle") return;
    logger.info("Initializing Campaign Simulator...");
    this.state = "running";
    this.scheduleTick();
  }

  public async pause(): Promise<void> {
    if (this.state !== "running") return;
    logger.info("Campaign paused. Active calls will complete naturally.");
    this.state = "paused";
    this.cancelScheduledTimer();
  }

  public async resume(): Promise<void> {
    if (this.state !== "paused") return;
    logger.info("Campaign resumed.");
    this.state = "running";
    this.scheduleTick();
  }

  public getStatus(): CampaignStatus {
    return {
      state: this.state,
      totalProcessed: this.successCount,
      totalFailed: this.failedCount,
      activeCalls: this.activeCallStartTimes.size,
      pendingRetries: this.pendingRetries.length,
      dailyMinutesUsed: this.calculateTotalDailyDurationMs() / 60_000,
    };
  }

  private scheduleTick(): void {
    if (this.tickInProgress) {
      this.needsReTick = true;
      return;
    }
    this.processAvailableSlots();
  }

  private processAvailableSlots(): void {
    this.tickInProgress = true;
    this.needsReTick = false;

    try {
      while (this.state === "running") {
        if (this.activeCallStartTimes.size >= this.config.maxConcurrentCalls) break;

        this.refreshDailyCap();
        
        if (this.calculateTotalDailyDurationMs() >= this.config.maxDailyMinutes * 60_000) {
          this.scheduleTimerAt(this.getNextMidnightMs());
          break;
        }

        if (!this.isWithinWorkingHours()) {
          this.scheduleTimerAt(this.getNextWorkingWindowStartMs());
          break;
        }

        const target = this.selectNextTarget();
        if (!target) {
          const nextRetry = this.getEarliestPendingRetry();
          if (nextRetry) {
            this.scheduleTimerAt(nextRetry.eligibleAtMs);
          } else if (this.activeCallStartTimes.size === 0) {
            this.state = "completed";
            logger.info("Campaign completed successfully!");
          }
          break;
        }

        this.placeCall(target.phoneNumber, target.priorAttempts);
      }
    } finally {
      this.tickInProgress = false;
      if (this.needsReTick) this.scheduleTick();
    }
  }

  private selectNextTarget(): { phoneNumber: string; priorAttempts: number } | null {
    const now = this.clock.now();
    let bestRetryIdx = -1;
    let earliestEligible = Infinity;
    let lowestSeq = Infinity;

    for (let i = 0; i < this.pendingRetries.length; i++) {
      const r = this.pendingRetries[i];
      if (r.eligibleAtMs <= now) {
        if (r.eligibleAtMs < earliestEligible || (r.eligibleAtMs === earliestEligible && r.retrySeq < lowestSeq)) {
          earliestEligible = r.eligibleAtMs;
          lowestSeq = r.retrySeq;
          bestRetryIdx = i;
        }
      }
    }

    if (bestRetryIdx !== -1) {
      const [retry] = this.pendingRetries.splice(bestRetryIdx, 1);
      return { phoneNumber: retry.phoneNumber, priorAttempts: retry.attempts };
    }

    if (this.queue.length > 0) {
      const phoneNumber = this.queue.shift()!;
      return { phoneNumber, priorAttempts: 0 };
    }

    return null;
  }

  private placeCall(phoneNumber: string, priorAttempts: number): void {
    const callStartTimeMs = this.clock.now();
    const callId = `${phoneNumber}-${Date.now()}-${Math.random()}`;
    this.activeCallStartTimes.set(callId, callStartTimeMs);

    this.callHandler(phoneNumber)
      .then((result) => this.safeOnCallComplete(callId, phoneNumber, priorAttempts, result, callStartTimeMs))
      .catch(() => this.safeOnCallComplete(callId, phoneNumber, priorAttempts, { answered: false, durationMs: 0 }, callStartTimeMs));
  }

  private safeOnCallComplete(callId: string, phoneNumber: string, priorAttempts: number, result: CallResult, callStartTimeMs: number): void {
    this.activeCallStartTimes.delete(callId);
    try {
      this.onCallComplete(phoneNumber, priorAttempts, result, callStartTimeMs);
    } catch {
      this.failedCount++;
    } finally {
      if (this.state === "running") this.scheduleTick();
    }
  }

  private onCallComplete(phoneNumber: string, priorAttempts: number, result: CallResult, callStartTimeMs: number): void {
    this.trackCallDuration(callStartTimeMs, result.durationMs);

    if (result.answered) {
      this.successCount++;
    } else {
      const nextAttempt = priorAttempts + 1;
      if (nextAttempt <= this.config.maxRetries) {
        this.pendingRetries.push({
          phoneNumber,
          attempts: nextAttempt,
          eligibleAtMs: this.clock.now() + this.config.retryDelayMs,
          retrySeq: this.retrySeqCounter++,
        });
      } else {
        this.failedCount++;
      }
    }
  }

  private calculateTotalDailyDurationMs(): number {
    this.refreshDailyCap();
    let total = this.dailyDurationMs;
    const now = this.clock.now();
    const midnightTs = this.nowInCampaignTz().startOf("day").toMillis();

    for (const startTime of this.activeCallStartTimes.values()) {
      const effectiveStart = Math.max(startTime, midnightTs);
      if (now > effectiveStart) {
        total += (now - effectiveStart);
      }
    }
    return total;
  }

  private trackCallDuration(callStartTimeMs: number, durationMs: number): void {
    if (durationMs <= 0) return;
    this.refreshDailyCap();
    
    const callEndTimeMs = callStartTimeMs + durationMs;
    const currentMidnightMs = this.nowInCampaignTz().startOf("day").toMillis();
    
    if (callStartTimeMs >= currentMidnightMs) {
      this.dailyDurationMs += durationMs;
    } else if (callEndTimeMs > currentMidnightMs) {
      this.dailyDurationMs += (callEndTimeMs - currentMidnightMs);
    }
  }

  private refreshDailyCap(): void {
    const todayStr = this.nowInCampaignTz().toISODate();
    if (todayStr && todayStr !== this.currentTrackingDay) {
      this.currentTrackingDay = todayStr;
      this.dailyDurationMs = 0;
    }
  }

  private isWithinWorkingHours(): boolean {
    const currentMs = this.currentMsOfDay();
    const start = this.parseTime(this.config.startTime);
    const end = this.parseTime(this.config.endTime);
    const sMs = start.hour * 3_600_000 + start.minute * 60_000;
    const eMs = end.hour * 3_600_000 + end.minute * 60_000;
    
    if (sMs === eMs) return false;
    return sMs < eMs 
      ? (currentMs >= sMs && currentMs < eMs) 
      : (currentMs >= sMs || currentMs < eMs);
  }

  private getNextWorkingWindowStartMs(): number {
    const dt = this.nowInCampaignTz();
    const start = this.parseTime(this.config.startTime);
    const end = this.parseTime(this.config.endTime);
    const sMs = start.hour * 3_600_000 + start.minute * 60_000;
    const eMs = end.hour * 3_600_000 + end.minute * 60_000;
    const cMs = this.currentMsOfDay();
    
    const target = sMs < eMs 
      ? (cMs < sMs ? dt : dt.plus({ days: 1 }))
      : (cMs >= eMs && cMs < sMs ? dt : dt.plus({ days: 1 }));
      
    return target.startOf("day").set({ hour: start.hour, minute: start.minute }).toMillis();
  }

  private scheduleTimerAt(timestamp: number): void {
    this.cancelScheduledTimer();
    const delay = Math.max(0, timestamp - this.clock.now());
    this.scheduledTimerId = this.clock.setTimeout(() => {
      this.scheduledTimerId = null;
      if (this.state === "running") this.scheduleTick();
    }, delay);
  }

  private cancelScheduledTimer(): void {
    if (this.scheduledTimerId !== null) {
      this.clock.clearTimeout(this.scheduledTimerId);
      this.scheduledTimerId = null;
    }
  }

  private getNextMidnightMs(): number {
    return this.nowInCampaignTz().plus({ days: 1 }).startOf("day").toMillis();
  }

  private getEarliestPendingRetry(): PendingRetry | null {
    if (this.pendingRetries.length === 0) return null;
    return this.pendingRetries.reduce((e, c) => (c.eligibleAtMs < e.eligibleAtMs ? c : e));
  }

  private nowInCampaignTz(): DateTime {
    const zone = this.config.timezone || "UTC";
    return DateTime.fromMillis(this.clock.now(), { zone });
  }

  private currentMsOfDay(): number {
    const dt = this.nowInCampaignTz();
    return dt.hour * 3_600_000 + dt.minute * 60_000 + dt.second * 1_000 + dt.millisecond;
  }

  private parseTime(timeStr: string): { hour: number; minute: number } {
    const [h, m] = timeStr.split(":").map(Number);
    return { hour: h, minute: m };
  }
}
