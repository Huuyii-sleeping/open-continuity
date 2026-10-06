# Lite benchmark

OpenContinuity includes a reproducible synthetic benchmark for the local SQLite Profile. It is intended to detect regressions and establish an order-of-magnitude baseline, not to promise identical latency across machines.

Run the default workload:

```bash
npm run benchmark:lite
```

Choose a smaller or larger workload without modifying the script:

```bash
npm run benchmark:lite -- --memories=1000 --iterations=50
npm run benchmark:lite -- --memories=100000 --iterations=200
```

The benchmark creates a temporary SQLite database, writes obviously fictional records, measures exact-key recall, FTS recall, and Context Pack construction, prints machine-readable JSON, and deletes the database. It never opens the user's configured database.

The output reports the platform, architecture, Node.js version, database size, seed throughput, and p50/p95/max latency. Compare results only when the dataset, runtime, hardware, power mode, and storage conditions are comparable.

For a release baseline, record the command and raw JSON in the release notes or CI artifact rather than committing machine-specific results as a universal claim. Performance regressions should be investigated when a repeatable test on the same environment materially changes p95 latency or database growth.
