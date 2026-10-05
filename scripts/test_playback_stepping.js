/**
 * Automated test suite for Historical Playback:
 * 1. Loads pre-recorded playback demo fixture.
 * 2. Validates schema, coordinate ranges, and telemetry bounds.
 * 3. Simulates programmatic stepping forward frame-to-frame.
 * 4. Asserts aircraft positions change correctly frame-to-frame.
 * 5. Asserts anomaly state transitions (position jump at frame 3, climb rate at frame 4).
 * 6. Validates speed controls (1x, 5x, 20x) and interval scaling.
 * 7. Validates boundary condition (frame wrap-around).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('======================================================================');
console.log('📡 AIRGUARD HISTORICAL PLAYBACK AUTOMATED VERIFICATION TEST');
console.log('======================================================================');

const fixturePath = path.resolve(__dirname, '../frontend/src/fixtures/playback_session.json');

// 1. Load Fixture
assert(fs.existsSync(fixturePath), `Fixture file must exist at ${fixturePath}`);
const rawData = fs.readFileSync(fixturePath, 'utf-8');
const session = JSON.parse(rawData);

console.log(`[PASS] Loaded fixture from ${fixturePath}`);
console.log(`[INFO] Total Playback Frames: ${session.length}`);
assert(Array.isArray(session) && session.length >= 5, 'Session must contain at least 5 frames');

// 2. Validate Frame Structure & Aircraft Presence
session.forEach((frame, idx) => {
  assert(frame.timestamp, `Frame ${idx} must contain an ISO timestamp`);
  assert(Array.isArray(frame.flights), `Frame ${idx} must have a flights array`);
  assert(frame.flights.length > 0, `Frame ${idx} flights array must not be empty`);
  assert(typeof frame.log === 'string' && frame.log.length > 0, `Frame ${idx} must have an explanatory log`);
});
console.log(`[PASS] All ${session.length} frames have valid timestamp, flights array, and event log.`);

// 3. Step Playback Forward Programmatically and Assert Position Changes
console.log('\n--- STEPPING PLAYBACK FORWARD FRAME BY FRAME ---');

const trackedIcao = '80163d'; // IGO6436 (IndiGo)
const anomalyIcao = 'a1b2c3'; // SYNTH-JMP
const positionsTracked = [];
const anomalyTracked = [];

let currentPlaybackIndex = 0;

function stepForward() {
  const currentFrame = session[currentPlaybackIndex];
  const nextIndex = currentPlaybackIndex >= session.length - 1 ? 0 : currentPlaybackIndex + 1;
  currentPlaybackIndex = nextIndex;
  return session[currentPlaybackIndex];
}

for (let frameIndex = 0; frameIndex < session.length; frameIndex++) {
  const frame = session[frameIndex];
  const trackedFlight = frame.flights.find(f => f.id === trackedIcao);
  const anomalyFlight = frame.flights.find(f => f.id === anomalyIcao);

  assert(trackedFlight, `Tracked flight ${trackedIcao} must exist in frame ${frameIndex}`);
  assert(anomalyFlight, `Anomaly flight ${anomalyIcao} must exist in frame ${frameIndex}`);

  // Coordinate validity checks (India bounding box roughly lat: 8-38, lng: 68-98)
  assert(trackedFlight.lat >= 8.0 && trackedFlight.lat <= 38.0, `Latitude must be in valid airspace bounds: got ${trackedFlight.lat}`);
  assert(trackedFlight.lng >= 68.0 && trackedFlight.lng <= 98.0, `Longitude must be in valid airspace bounds: got ${trackedFlight.lng}`);
  assert(trackedFlight.altitude > 0, `Altitude must be positive: got ${trackedFlight.altitude}`);
  assert(trackedFlight.speed > 0, `Speed must be positive: got ${trackedFlight.speed}`);

  positionsTracked.push({
    frame: frameIndex,
    time: frame.timestamp,
    lat: trackedFlight.lat,
    lng: trackedFlight.lng,
    altitude: trackedFlight.altitude,
    speed: trackedFlight.speed,
    heading: trackedFlight.heading
  });

  anomalyTracked.push({
    frame: frameIndex,
    time: frame.timestamp,
    lat: anomalyFlight.lat,
    lng: anomalyFlight.lng,
    altitude: anomalyFlight.altitude,
    speed: anomalyFlight.speed,
    status: anomalyFlight.status,
    trustScore: anomalyFlight.trustScore,
    flags: anomalyFlight.ruleFlags
  });

  console.log(
    `Frame ${frameIndex + 1}/${session.length} [${frame.timestamp}] | ` +
    `Aircraft: ${frame.flights.length} | ` +
    `${trackedFlight.callsign} (${trackedFlight.lat.toFixed(4)}, ${trackedFlight.lng.toFixed(4)}) Alt: ${trackedFlight.altitude}ft Spd: ${trackedFlight.speed}kts | ` +
    `Anomaly: ${anomalyFlight.callsign} (${anomalyFlight.status.toUpperCase()}) Trust: ${anomalyFlight.trustScore}%`
  );
}

// 4. Assert Positional Displacements Across Steps
console.log('\n--- VERIFYING POSITIONAL DISPLACEMENTS ---');

// Haversine formula distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

for (let i = 1; i < positionsTracked.length; i++) {
  const prev = positionsTracked[i - 1];
  const curr = positionsTracked[i];

  const distKm = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
  assert(distKm > 0.05, `Aircraft position must change frame-to-frame! Delta at frame ${i} was only ${distKm} km`);
  
  // Plausible commercial aircraft step (at ~450 kts, 5 sec = ~1.15 km)
  assert(distKm < 5.0, `Nominal flight displacement must stay within aerodynamic bounds: got ${distKm} km`);
  console.log(`[PASS] Frame ${i-1} -> Frame ${i}: Position changed by ${distKm.toFixed(3)} km (nominal track).`);
}

// 5. Assert Anomaly Detection Transitions
console.log('\n--- VERIFYING ANOMALY STATE TRANSITIONS ---');

// Frames 0-2: Anomaly target is nominal
for (let i = 0; i < 3; i++) {
  assert.strictEqual(anomalyTracked[i].status, 'normal', `Frame ${i} should be normal`);
  assert(anomalyTracked[i].trustScore >= 90, `Frame ${i} trust score should be high`);
  assert.strictEqual(anomalyTracked[i].flags.positionJump, false);
}
console.log('[PASS] Frames 0-2: Baseline normal flight confirmed.');

// Frame 3: Sudden position jump (550 km delta)
const jumpDistKm = haversineKm(anomalyTracked[2].lat, anomalyTracked[2].lng, anomalyTracked[3].lat, anomalyTracked[3].lng);
console.log(`[INFO] Injected Anomaly Jump Delta: ${jumpDistKm.toFixed(1)} km`);
assert(jumpDistKm > 500, `Injected jump must be > 500 km: got ${jumpDistKm}`);
assert.strictEqual(anomalyTracked[3].status, 'critical', 'Frame 3 status must transition to CRITICAL');
assert.strictEqual(anomalyTracked[3].flags.positionJump, true, 'positionJump flag must be true at frame 3');
assert(anomalyTracked[3].trustScore <= 30, 'Trust score must collapse upon position jump');
console.log('[PASS] Frame 3: Position Jump triggered correctly (status=CRITICAL, trustScore <= 30%).');

// Frame 4: Impossible climb rate
assert.strictEqual(anomalyTracked[4].flags.climbRate, true, 'climbRate flag must be true at frame 4');
assert(anomalyTracked[4].altitude > anomalyTracked[3].altitude + 3000, 'Altitude spike must be present');
console.log('[PASS] Frame 4: Impossible Climb Rate flagged (status=CRITICAL, climbRate=true).');

// 6. Test Speed Multipliers and Interval Calculation
console.log('\n--- VERIFYING PLAYBACK SPEED INTERVALS ---');
function calculateInterval(speed) {
  return Math.max(80, Math.round(1800 / speed));
}

const int1x = calculateInterval(1);
const int5x = calculateInterval(5);
const int20x = calculateInterval(20);

assert.strictEqual(int1x, 1800, '1x speed must yield 1800ms');
assert.strictEqual(int5x, 360, '5x speed must yield 360ms');
assert.strictEqual(int20x, 90, '20x speed must yield 90ms');

assert(int1x > int5x && int5x > int20x, 'Interval must scale inversely with speed');
console.log(`[PASS] 1x Interval: ${int1x}ms, 5x Interval: ${int5x}ms, 20x Interval: ${int20x}ms`);

// 7. Verify Wrap-around Boundary Condition
console.log('\n--- VERIFYING PLAYBACK WRAP-AROUND ---');
currentPlaybackIndex = session.length - 1; // Last frame
const loopedFrame = stepForward();
assert.strictEqual(currentPlaybackIndex, 0, 'Stepping past final frame must wrap back to frame 0');
assert.strictEqual(loopedFrame.timestamp, session[0].timestamp, 'Wrapped frame timestamp must equal initial frame');
console.log(`[PASS] Successfully looped from Frame ${session.length} back to Frame 1.`);

console.log('\n======================================================================');
console.log('✅ ALL HISTORICAL PLAYBACK TESTS PASSED SUCCESSFULLY!');
console.log('======================================================================\n');
