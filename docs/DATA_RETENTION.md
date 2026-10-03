# Data Retention and Downsampling Policy

This document establishes the data management guidelines and downsampling routines implemented in AirGuard to balance database performance with historical analysis capabilities.

---

## 1. Data Retention Classifications

| Table | Retention Period | Action | Rationale |
| :--- | :--- | :--- | :--- |
| `aircraft_states` (Unlinked) | 30 Days | Downsample to 1-in-10 records | Raw telemetry updates are received every 8 seconds, generating millions of records. Historical trends are fully preserved with downsampled resolution. |
| `aircraft_states` (Linked) | Indefinite | Retain | Must be preserved to ensure foreign key constraint integrity for associated alerts. |
| `alerts` | Indefinite | Retain | Critical for regulatory compliance, safety audits, and forensic replays. |
| `model_runs` | Indefinite | Retain | Required for comparing ML model version drifts and precision/recall histories. |
| `audit_log` | Indefinite | Retain | Operational security compliance logs showing mutations and user interventions. |

---

## 2. Downsampling Algorithm

The downsampling job runs on a scheduled basis (e.g., nightly cron job). It evaluates records that satisfy two criteria:
1. `received_at` is older than 30 days.
2. The record is **not** referenced by any row in the `alerts` table (safeguards foreign key constraints).

### SQL Downsampling Definition
The job groups older state records sequentially by aircraft (`icao24`) ordered by time, and assigns sequence numbers. It preserves records where `seq_num % 10 == 1` and deletes the remaining 9 records:

```sql
WITH numbered_states AS (
    SELECT id, 
           ROW_NUMBER() OVER (PARTITION BY icao24 ORDER BY received_at ASC) as rn
    FROM aircraft_states
    WHERE received_at < NOW() - INTERVAL '30 days'
      AND id NOT IN (SELECT aircraft_state_id FROM alerts)
)
DELETE FROM aircraft_states 
WHERE id IN (
    SELECT id 
    FROM numbered_states 
    WHERE rn % 10 != 1
);
```

---

## 3. Scheduled Execution

The downsampling task is packaged as a standalone python executable:
`python backend/app/tasks/retention.py --days 30`

### Dry-Run Safeguard
The script supports a `--dry-run` flag which executes the partition analysis and logs exactly how many records would be deleted without running any actual mutations on the tables. This is run as part of pre-release validation checks to verify query accuracy.
