import { DateTime } from "luxon";
import { CampaignConfig } from "../interfaces";

export function normalizeAndValidateConfig(config: CampaignConfig): CampaignConfig {
  const normalized = {
    ...config,
    maxRetries: config.maxRetries ?? 2,
    retryDelayMs: config.retryDelayMs ?? 3_600_000,
    timezone: config.timezone || "UTC",
  };

  if (!DateTime.local({ zone: normalized.timezone }).isValid) {
    throw new Error(`Invalid timezone provided: ${normalized.timezone}`);
  }

  if (normalized.maxConcurrentCalls <= 0 || !Number.isInteger(normalized.maxConcurrentCalls)) {
    throw new Error("maxConcurrentCalls must be a positive integer.");
  }

  const timeRegex = /^([0-1]\d|2[0-3]):[0-5]\d$/;
  if (!timeRegex.test(normalized.startTime) || !timeRegex.test(normalized.endTime)) {
    throw new Error("startTime and endTime must be in strictly valid HH:mm format.");
  }

  return normalized;
}
