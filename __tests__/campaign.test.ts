import assert from "assert/strict";
import { Campaign } from "../src/Campaign";
import { CampaignConfig, CallHandler, IClock, CallResult } from "../interfaces";

async function runTests() {
  console.log("RUNNING CAMPAIGN SIMULATOR TESTS");

  let currentTime = 1000000;

  const mockClock: IClock = {
    now: () => currentTime,
    setTimeout: (cb, delay) => {
      return setTimeout(cb, 10) as any;
    },
    clearTimeout: (id) => clearTimeout(id as any),
  };

  const mockCallHandler: CallHandler = async (
    phone: string,
  ): Promise<CallResult> => {
    return { answered: true, durationMs: 1500 };
  };

  const baseConfig: CampaignConfig = {
    customerList: ["+111", "+222"],
    startTime: "00:00",
    endTime: "23:59",
    maxConcurrentCalls: 2,
    maxDailyMinutes: 10,
    maxRetries: 1,
    retryDelayMs: 1000,
    timezone: "UTC",
  };

  console.log("\n[Test 1] Initialization & Status Check");
  const campaign = new Campaign(baseConfig, mockCallHandler, mockClock);
  assert.strictEqual(
    campaign.getStatus().state,
    "idle",
    "Campaign should start in 'idle' state",
  );
  assert.strictEqual(
    campaign.getStatus().totalProcessed,
    0,
    "Processed count should be 0",
  );
  console.log("Passed");

  console.log("\n[Test 2] Invalid Config Rejection");
  try {
    new Campaign(
      { ...baseConfig, timezone: "Fake/Zone" },
      mockCallHandler,
      mockClock,
    );
    assert.fail("Should have thrown an error for invalid timezone");
  } catch (err: any) {
    assert.match(
      err.message,
      /Invalid timezone provided/,
      "Error message should mention invalid timezone",
    );
    console.log("Passed");
  }

  try {
    new Campaign(
      { ...baseConfig, startTime: "invalid_time" },
      mockCallHandler,
      mockClock,
    );
    assert.fail("Should have thrown an error for invalid startTime");
  } catch (err: any) {
    assert.match(
      err.message,
      /startTime and endTime must be in strictly valid HH:mm format/,
      "Error message should mention strictly valid HH:mm",
    );
    console.log("Passed");
  }

  console.log("\nAll unit tests completed successfully.");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
