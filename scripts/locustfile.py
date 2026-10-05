from locust import HttpUser, task, between, events
import httpx
import random

SHARED_TOKEN = None

@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    global SHARED_TOKEN
    base = environment.host or "http://127.0.0.1:8001"
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"{base}/api/v1/auth/login",
                data={"username": "viewer@airguard.sec", "password": "AirGuard2026!"}
            )
            if resp.status_code == 200:
                SHARED_TOKEN = resp.json().get("access_token")
    except Exception as e:
        print(f"Error fetching initial test token: {e}")

class DashboardUser(HttpUser):
    wait_time = between(0.1, 0.5)

    def on_start(self):
        global SHARED_TOKEN
        self.client_ip = f"10.0.{random.randint(1, 250)}.{random.randint(1, 250)}"
        self.headers = {
            "Authorization": f"Bearer {SHARED_TOKEN}",
            "X-Forwarded-For": self.client_ip
        }
        self.known_icaos = ["01013d", "01025d", "040032", "040065", "040102", "040106", "040172", "040173", "040261", "04c11a"]

    @task(5)
    def get_aircraft_snapshot(self):
        """Simulate polling the live aircraft map snapshot."""
        with self.client.get("/api/v1/aircraft?limit=100", headers=self.headers, catch_response=True) as resp:
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and len(data) > 0:
                    for item in data[:5]:
                        sample_icao = item.get("icao24")
                        if sample_icao and sample_icao not in self.known_icaos:
                            self.known_icaos.append(sample_icao)
                resp.success()
            else:
                resp.failure(f"HTTP {resp.status_code}")

    @task(3)
    def get_system_health(self):
        """Simulate checking system telemetry health."""
        with self.client.get("/api/v1/system-health", headers=self.headers, catch_response=True) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"HTTP {resp.status_code}")

    @task(2)
    def get_recent_alerts(self):
        """Simulate checking the security alerts feed."""
        with self.client.get("/api/v1/alerts?limit=20", headers=self.headers, catch_response=True) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"HTTP {resp.status_code}")

    @task(1)
    def get_trust_history(self):
        """Simulate opening an aircraft detail panel."""
        icao = random.choice(self.known_icaos)
        with self.client.get(f"/api/v1/aircraft/{icao}/trust-history", headers=self.headers, catch_response=True) as resp:
            if resp.status_code in (200, 404):
                resp.success()
            else:
                resp.failure(f"HTTP {resp.status_code}")

    @task(1)
    def get_config(self):
        """Simulate loading configuration thresholds."""
        with self.client.get("/api/v1/config", headers=self.headers, catch_response=True) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"HTTP {resp.status_code}")
