import os
import sys
import asyncio
import argparse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Detection Worker Replica Runner")
    parser.add_argument("--worker-name", type=str, default="worker-replica-1", help="Worker name in consumer group")
    args = parser.parse_args()

    os.environ["HOSTNAME"] = args.worker_name

    from app.worker import main
    print(f"⚙️ Starting AirGuard Detection Worker [{args.worker_name}]...", flush=True)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"Detection Worker [{args.worker_name}] stopped.")
