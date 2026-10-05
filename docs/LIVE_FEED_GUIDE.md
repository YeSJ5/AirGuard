# Live feed evaluation guide

AirGuard displays real aircraft reports received from the global OpenSky state feed. It does not substitute generated or prerecorded aircraft when the provider is empty, offline, or rate-limited.

## Before use

1. Start the configured services using the repository setup instructions.
2. Confirm the feed status and last successful poll before interpreting any position as current.
3. Configure an OpenSky OAuth2 API client (`OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`) when higher global query quotas are needed. Never add credentials to source control.
4. If the provider reports a rate limit or outage, the map remains empty or retains only reports within its live retention window, marked stale as appropriate.

## Explore live reports

Search by callsign or ICAO address, select an aircraft, and follow its reported positions as updates arrive. Route endpoints and aircraft metadata are best-effort enrichment and can be unavailable or inferred; they are not guaranteed flight-plan data.

## Review an alert

Open a track with a recorded review alert, if available. Read the rule or detector evidence and its timestamp. Separate the observed report from the detector's interpretation. No active alerts does not establish that a track is authentic or safe.

## Coverage limits

AirGuard requests the provider's global state feed. The result is not a complete census of aircraft: visibility depends on receiver coverage, aircraft transmissions, provider availability, and account quota. The map is an awareness and learning view, not an air traffic control display.

## Polling and quota behavior

The application defaults to a 90-second global polling interval when OpenSky OAuth2 credentials are configured and 900 seconds when requests are anonymous. `OPENSKY_POLL_INTERVAL_SECONDS` can override these defaults, but setting a shorter interval does not create extra provider capacity and can exhaust the account quota. OpenSky documents a 400-credit daily anonymous quota and a 4,000-credit daily standard-user quota; a global `/states/all` request costs four credits. This is why the anonymous default is deliberately much slower than the provider's state update resolution. An authenticated provider account, receiver coverage and successful polls are all required for fresher global snapshots.

OpenSky documents 10-second state resolution for anonymous requests and 5-second resolution for authenticated requests. AirGuard must display the timestamp of the reported observation; a poll time is not the same as the aircraft report time. See the [official REST API limitations and credit table](https://openskynetwork.github.io/opensky-api/rest.html#limitations) before changing the configured poll interval.

OpenSky now requires OAuth2 client-credentials authentication for authenticated REST API access; HTTP Basic username/password authentication is no longer accepted. See the [official authentication instructions](https://openskynetwork.github.io/opensky-api/rest.html#authentication).
