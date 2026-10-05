import time
import httpx
import redis
import json
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

API_BASE = "http://127.0.0.1:8001/api/v1"

def run_benchmark():
    print("=" * 70)
    print("[BENCHMARK] AIRGUARD ENTERPRISE CACHE: Cold DB vs Warm Redis Cache")
    print("=" * 70)

    # 1. Connect to Redis to clear cache keys
    r = redis.Redis(host="127.0.0.1", port=6379, db=0)
    try:
        r.ping()
        print("Connected to Redis at 127.0.0.1:6379")
    except Exception as e:
        print(f"Failed to connect to Redis: {e}")
        return

    # 2. Login as viewer
    client = httpx.Client(timeout=10.0)
    login_res = client.post(
        f"{API_BASE}/auth/login",
        data={"username": "viewer@airguard.sec", "password": "AirGuard2026!"}
    )
    if login_res.status_code != 200:
        print(f"Failed to login: {login_res.status_code} {login_res.text}")
        return
    
    token = login_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    print("Logged in as viewer@airguard.sec")

    test_cases = [
        {
            "name": "Live Aircraft Telemetry Snapshot",
            "endpoint": "/aircraft?limit=100",
            "cache_pattern": "cache:aircraft:snapshot:*"
        },
        {
            "name": "ML Model Run History",
            "endpoint": "/model-runs?limit=50",
            "cache_pattern": "cache:model_runs:all:*"
        }
    ]

    results = []

    for tc in test_cases:
        print(f"\n--- Testing Query: {tc['name']} ({tc['endpoint']}) ---")
        # Invalidate existing cache keys
        keys = r.keys(tc["cache_pattern"])
        if keys:
            r.delete(*keys)
        print(f"Cache invalidated for pattern: {tc['cache_pattern']}")

        # 1. Cold Query (hitting PostgreSQL)
        t0 = time.perf_counter()
        cold_res = client.get(f"{API_BASE}{tc['endpoint']}", headers=headers)
        cold_latency_ms = (time.perf_counter() - t0) * 1000.0
        assert cold_res.status_code == 200, f"Cold request failed: {cold_res.status_code}"
        cold_count = len(cold_res.json())
        print(f"Cold (DB Query):    {cold_latency_ms:6.2f} ms | Records: {cold_count}")

        # 2. Warm Queries (hitting Redis Cache)
        warm_latencies = []
        for i in range(10):
            t1 = time.perf_counter()
            warm_res = client.get(f"{API_BASE}{tc['endpoint']}", headers=headers)
            warm_latency = (time.perf_counter() - t1) * 1000.0
            assert warm_res.status_code == 200, f"Warm request failed: {warm_res.status_code}"
            warm_latencies.append(warm_latency)

        avg_warm_ms = sum(warm_latencies) / len(warm_latencies)
        min_warm_ms = min(warm_latencies)
        p95_warm_ms = sorted(warm_latencies)[int(len(warm_latencies) * 0.95)]
        speedup = cold_latency_ms / avg_warm_ms if avg_warm_ms > 0 else 1.0

        print(f"Warm (Redis Cache): {avg_warm_ms:6.2f} ms (p95: {p95_warm_ms:.2f} ms, min: {min_warm_ms:.2f} ms)")
        print(f"Speedup Factor:     {speedup:6.1f}x faster with Redis caching")

        results.append({
            "name": tc["name"],
            "endpoint": tc["endpoint"],
            "cold_ms": cold_latency_ms,
            "warm_avg_ms": avg_warm_ms,
            "speedup": speedup,
            "records": cold_count
        })

    print("\n" + "=" * 70)
    print("BENCHMARK SUMMARY")
    print("=" * 70)
    print(f"{'Endpoint':<35} | {'Cold DB':<10} | {'Warm Redis':<10} | {'Speedup':<8}")
    print("-" * 70)
    for r in results:
        print(f"{r['name']:<35} | {r['cold_ms']:6.2f} ms | {r['warm_avg_ms']:6.2f} ms | {r['speedup']:5.1f}x")
    print("=" * 70)

if __name__ == "__main__":
    run_benchmark()
