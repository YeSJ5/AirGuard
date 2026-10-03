# Live feed evaluation guide

AirGuard displays real aircraft reports received from the global OpenSky state feed. It does not substitute generated or prerecorded aircraft when the provider is empty, offline, or rate-limited.

## Before use

1. Start the configured services using the repository setup instructions.
2. Confirm the feed status and last successful poll before interpreting any position as current.
3. Configure valid provider credentials when higher global query quotas are needed. Never add credentials to source control.
4. If the provider reports a rate limit or outage, the map remains empty or retains only reports within its live retention window, marked stale as appropriate.

## Explore live reports

Search by callsign or ICAO address, select an aircraft, and follow its reported positions as updates arrive. Route endpoints and aircraft metadata are best-effort enrichment and can be unavailable or inferred; they are not guaranteed flight-plan data.

## Review an alert

Open a track with a recorded review alert, if available. Read the rule or detector evidence and its timestamp. Separate the observed report from the detector's interpretation. No active alerts does not establish that a track is authentic or safe.

## Coverage limits

AirGuard requests the provider's global state feed. The result is not a complete census of aircraft: visibility depends on receiver coverage, aircraft transmissions, provider availability, and account quota. The map is an awareness and learning view, not an air traffic control display.
