import os
import sys
import argparse
import uvicorn

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Ensure backend directory is in sys.path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard API Replica Runner")
    parser.add_argument("--port", type=int, default=8001, help="Port to bind API replica")
    parser.add_argument("--replica-id", type=str, default="api-replica-1", help="Unique replica ID")
    parser.add_argument("--run-ingestion", type=str, default="true", help="Enable OpenSky polling on this replica")
    parser.add_argument("--enable-detection", type=str, default="false", help="Enable in-process detection")
    args = parser.parse_args()

    os.environ["REPLICA_ID"] = args.replica_id
    os.environ["RUN_INGESTION"] = args.run_ingestion
    os.environ["ENABLE_IN_PROCESS_DETECTION"] = args.enable_detection

    print(f"🚀 Starting AirGuard API Replica [{args.replica_id}] on port {args.port} (Ingestion: {args.run_ingestion}, InProcessDetection: {args.enable_detection})...")
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, log_level="info")
