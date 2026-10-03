# Enterprise Scaling & Production Notes

If **AirGuard** were deployed to monitor a real-world national airspace (such as the United States or European skies), the scale of ingestion, processing, and storage requirements would shift by orders of magnitude. Below is a production blueprint outlining scale characteristics, architectural upgrades, and cloud cost projections.

---

## 1. Expected Load at Scale

In a national-level deployment (e.g., US Airspace), the station must handle:
* **Active Targets**: Up to **10,000 concurrent aircraft** during peak operational windows.
* **Update Frequency**: Live ADS-B broadcasts emit state packets at **1Hz** (1 report per second per aircraft).
* **Ingestion Throughput**: 
  $$\text{Throughput} = 10,000\text{ aircraft} \times 1\text{ Hz} = 10,000\text{ messages/second}$$
* **Network Ingress Bandwidth**: 
  With an average telemetry payload size of 200 bytes:
  $$10,000\text{ msg/sec} \times 200\text{ bytes} \approx 2.0\text{ MB/s} \text{ (16 Mbps)}$$
* **Daily Ingest Volume**:
  $$10,000\text{ msg/sec} \times 86,400\text{ seconds/day} = 864,000,000\text{ rows/day}$$
  $$864\text{M rows/day} \times 200\text{ bytes} \approx 172.8\text{ GB/day of raw telemetry (unindexed)}$$
* **Monthly Accumulation**: ~5.2 TB of raw telemetry per month.

---

## 2. Recommended Production Upgrades

### A. PostgreSQL Partitioning Strategy
Storing 864 million raw rows per day in a flat table will cause indexes to bloat beyond memory capacity, rendering query execution times unusable.
* **Time-Series Partitioning**: Partition the `aircraft_states` table by **Range** on the `received_at` timestamp.
  * Implement **daily partitions** (e.g., `aircraft_states_y2026_m08_d10`).
  * Use **pg_partman** to automatically pre-create partition tables in advance.
* **Data Downsampling & Archiving**:
  * Keep only the last **30 days** of raw 1Hz states in the hot transactional DB (approx. 5.2 TB).
  * Run a nightly worker job that detaches partitions older than 30 days, downsamples the telemetry to **1-in-10 ticks** (retaining 10-second granularity for historical playbacks), and bulk-moves the downsampled data to cold analytical stores.
  * Compress and export the raw daily partitions to **AWS S3 / GCP Cloud Storage** in columnar **Parquet** format. This allows serverless query engines (like AWS Athena or Google BigQuery) to execute analytical audits on petabytes of historical data without impacting transactional runtimes.

### B. Dedicated ML Inference Layer
Running deep learning models (such as autoencoders or PyTorch classifiers) inline within Python worker processes leads to severe CPU contention, high model loading overhead across worker replicas, and limits performance.
* **Triton Inference Server / TF Serving**: Extract model evaluation from the rule-checking worker and place models behind **Triton Inference Server** instances.
* **High-Performance Communication**: Workers serialize states and send them via **gRPC** to Triton.
* **Benefits**:
  * **Dynamic Batching**: Triton automatically queues and groups incoming high-frequency requests, optimizing GPU matrix utilization.
  * **GPU Acceleration**: Offloads Autoencoder evaluations to GPU instances (e.g., NVIDIA T4), leaving workers to perform fast CPU-bound mathematical checks (e.g., geo-trilateration).
  * **Zero-Downtime Updates**: Update detection model weights on Triton dynamically without restarting the ingestion or worker services.

---

## 3. Back-of-the-Envelope Cloud Cost Estimate

For a highly available production station tracking 10,000 concurrent aircraft:

| Component | AWS Resource Details | Monthly Cost (USD) | Rationale |
| :--- | :--- | :--- | :--- |
| **Compute (API Gateway)** | 5 $\times$ `t3.medium` instances (ECS/EKS) | \$150 | Handles WebSocket client connections and REST queries. |
| **Compute (Workers)** | 10 $\times$ `c6i.large` compute-optimized | \$620 | Performs geo-trilateration, rule evaluations, and stream reads. |
| **Compute (Inference)** | 2 $\times$ `g4dn.xlarge` (NVIDIA T4 GPUs) | \$760 | Runs autoencoders and XGBoost threat classifiers. |
| **Database** | AWS Aurora Postgres (`db.r6g.xlarge` Multi-AZ) | \$360 | Transactional database for user profiles, configuration, and alerts. |
| **Database Storage** | Provisioned IOPS (5.2 TB hot time-series storage) | \$700 | Handles heavy concurrent writes (10k writes/sec). |
| **In-Memory Store** | AWS ElastiCache Redis Cluster (`cache.m6g.large`) | \$350 | Multi-AZ cluster for high-speed telemetry streams and WS pub/sub. |
| **Cold Storage** | AWS S3 Standard + Glacier Deep Archive (20 TB) | \$150 | Columnar Parquet time-series archive for deep diagnostics. |
| **Observability** | Managed Prometheus + Grafana Cloud + Jaeger | \$500 | End-to-end tracing, latency dashboards, and query monitoring. |
| **Network & Ingress** | Inter-AZ Transfer & ADS-B Data feeds | \$200 | Ingestion network transfer overhead. |
| **Total Monthly Cost** | | **\$3,790 / month** | |
