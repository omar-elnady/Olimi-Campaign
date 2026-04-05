# Call Campaign Simulator

A scalable, reliable call campaign simulator built in TypeScript, designed to coordinate concurrent phone connections under precise time and capacity configurations.

## Setup & Installation

**Prerequisites:** 
- Node.js 18+

1. Install project dependencies:
   ```bash
   npm install
   ```

2. Compile TypeScript source code:
   ```bash
   npx tsc
   ```

## Directory Structure

```text
├── interfaces.ts         # Contract interfaces
├── solution.ts           # Root integration export
├── demo.ts               # Ready-to-run interactive demo script
├── src/
│   ├── Campaign.ts       # Core campaign engine logic
│   ├── validator.ts      # Native configuration validations
│   └── utils/
│       └── logger.ts     # Internal logger implementation
├── __tests__/
│   └── campaign.test.ts  # Validation testing via Node 'assert'
├── package.json          
└── tsconfig.json         
```

## Testing & Execution

The repository provides automated unit tests for validation cases, alongside a dedicated script for observing integration logic locally.

**Running the Unit Tests:**
To validate internal configuration behavior and timezone rejections:
```bash
npx tsx __tests__/campaign.test.ts
```

**Local Integration Demo:**
We've provided a `demo.ts` file that uses a mock clock and a mock call handler with a 30% failure rate to demonstrate both the happy path and retry logic.

Run the demo script:
```bash
npx tsx demo.ts
```

## Technical Implementation Details

1. **Daily Minutes (Real-Time Tracking):** The engine tracks start times of currently active calls to calculate "live" usage. This ensures we never exceed the dailyMinutes cap while calls are still running.
2. **Timezone Awareness:** All session boundaries and daily resets are evaluated using the specified IANA timezone (via Luxon).
3. **Resilient Retries:** Failed calls are queued at the exact millisecond their delay expires, prioritizing them alongside the existing channel queue.
4. **Pause/Resume:** The engine stops initiating new calls immediately upon a pause command, while allowing active calls to complete naturally as per the spec.

## License

MIT
