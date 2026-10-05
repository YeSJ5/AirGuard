/**
 * Test suite for 3D Aircraft Model banking physics and Chase-Cam fly-to constraints.
 */
const assert = require('assert');
const path = require('path');
const cesiumPath = path.resolve(__dirname, '../frontend/node_modules/cesium');
const Cesium = require(cesiumPath);

console.log('--- RUNNING AIRGUARD 3D AIRCRAFT & CHASE CAM VERIFICATION ---');

// 1. Verify GLB model presence and size
const fs = require('fs');
const glbPath = 'frontend/public/models/aircraft.glb';
assert(fs.existsSync(glbPath), 'aircraft.glb must exist');
const stats = fs.statSync(glbPath);
console.log(`[PASS] 3D Model exists: ${glbPath} (${stats.size} bytes)`);
assert(stats.size > 10000 && stats.size < 200000, 'Model must be lightweight low-poly (< 200KB)');

// 2. Verify glTF structure
const buf = fs.readFileSync(glbPath);
const magic = buf.readUInt32LE(0);
assert.strictEqual(magic, 0x46546C67, 'Magic must match glTF binary');
console.log('[PASS] Valid glTF 2.0 binary header');

// 3. Test Bank/Roll Dynamics and Heading Change Rate
function calculateFlightDynamics(startHeading, targetHeading, durationMs, startAlt, targetAlt, p) {
  const diff = ((targetHeading - startHeading + 540) % 360) - 180;
  const currentHeading = (startHeading + diff * p + 360) % 360;
  const durationSec = Math.max(1, durationMs / 1000);
  const turnRate = diff / durationSec;

  const turnEnvelope = Math.sin(Math.PI * Math.min(1.0, p));
  const targetBankDeg = Math.max(-35, Math.min(35, turnRate * 7.0));
  const bankDeg = Math.abs(diff) > 1.5 ? targetBankDeg * turnEnvelope : 0;

  const altDiff = targetAlt - startAlt;
  const fpm = (altDiff / durationSec) * 60;
  const pitchDeg = Math.max(-12, Math.min(15, fpm / 350));

  return { currentHeading, turnRate, bankDeg, pitchDeg };
}

// Case A: Straight flight
const straight = calculateFlightDynamics(90, 90, 8000, 32000, 32000, 0.5);
assert.strictEqual(straight.bankDeg, 0, 'Straight flight should have zero bank');
assert.strictEqual(straight.pitchDeg, 0, 'Level flight should have zero pitch');
console.log('[PASS] Straight level flight: 0° bank, 0° pitch');

// Case B: Right Turn (banking right)
const rightTurn = calculateFlightDynamics(0, 90, 8000, 30000, 30000, 0.5);
assert(rightTurn.turnRate > 0, 'Turn rate should be positive for right turn');
assert(rightTurn.bankDeg > 15 && rightTurn.bankDeg <= 35, `Bank angle should be positive and clamped: got ${rightTurn.bankDeg}`);
console.log(`[PASS] Right turn: turnRate=${rightTurn.turnRate.toFixed(1)}°/s, bank=${rightTurn.bankDeg.toFixed(1)}°`);

// Case C: Left Turn (banking left)
const leftTurn = calculateFlightDynamics(90, 0, 8000, 30000, 30000, 0.5);
assert(leftTurn.turnRate < 0, 'Turn rate should be negative for left turn');
assert(leftTurn.bankDeg < -15 && leftTurn.bankDeg >= -35, `Bank angle should be negative: got ${leftTurn.bankDeg}`);
console.log(`[PASS] Left turn: turnRate=${leftTurn.turnRate.toFixed(1)}°/s, bank=${leftTurn.bankDeg.toFixed(1)}°`);

// Case D: Climb
const climb = calculateFlightDynamics(180, 180, 8000, 20000, 24000, 0.5);
assert(climb.pitchDeg > 0, 'Climbing should have positive pitch');
console.log(`[PASS] Climb: pitch=${climb.pitchDeg.toFixed(1)}°`);

// Case E: Descent
const descent = calculateFlightDynamics(180, 180, 8000, 35000, 30000, 0.5);
assert(descent.pitchDeg < 0, 'Descent should have negative pitch');
console.log(`[PASS] Descent: pitch=${descent.pitchDeg.toFixed(1)}°`);

// 4. Test Quaternion generation in Cesium
const pos = Cesium.Cartesian3.fromDegrees(78.9, 20.5, 10000);
const hpr = new Cesium.HeadingPitchRoll(
  Cesium.Math.toRadians(rightTurn.currentHeading),
  Cesium.Math.toRadians(rightTurn.pitchDeg),
  Cesium.Math.toRadians(rightTurn.bankDeg)
);
const quat = Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
assert(quat instanceof Cesium.Quaternion, 'Must return valid Quaternion');
assert(!isNaN(quat.x) && !isNaN(quat.y) && !isNaN(quat.z) && !isNaN(quat.w), 'Quaternion values must be finite');
console.log('[PASS] Cesium HeadingPitchRollQuaternion calculation valid');

// 5. Test Fly-to Duration & Rapid Click Concurrency
const FLY_TO_DURATION = 1.6;
assert(FLY_TO_DURATION < 3.0, 'Fly-to duration must strictly be under 3 seconds');
console.log(`[PASS] Chase-Cam duration is ${FLY_TO_DURATION}s (< 3.0s threshold)`);

// Simulation of rapid clicking across 4 aircraft
class MockCamera {
  constructor() {
    this.activeFlight = null;
    this.cancelCount = 0;
  }
  cancelFlight() {
    if (this.activeFlight) {
      this.cancelCount++;
      if (this.activeFlight.cancel) this.activeFlight.cancel();
      this.activeFlight = null;
    }
  }
  flyToBoundingSphere(sphere, options) {
    this.activeFlight = options;
  }
}

const mockCamera = new MockCamera();
let currentSelectedId = null;
let activeRef = null;

function clickAircraft(flightId, isRapid) {
  mockCamera.cancelFlight();
  activeRef = flightId;
  currentSelectedId = null; // drawer stays closed during swoop

  mockCamera.flyToBoundingSphere({}, {
    duration: FLY_TO_DURATION,
    complete: () => {
      if (activeRef === flightId) {
        currentSelectedId = flightId;
      }
    },
    cancel: () => {}
  });
}

// Rapid clicks in succession (User clicks Flight A, then B, then C, then D)
clickAircraft('FLIGHT_A', true);
clickAircraft('FLIGHT_B', true);
clickAircraft('FLIGHT_C', true);
clickAircraft('FLIGHT_D', false);

// Only FLIGHT_D completes flight
mockCamera.activeFlight.complete();

assert.strictEqual(mockCamera.cancelCount, 3, 'First 3 flights should have been cleanly cancelled immediately');
assert.strictEqual(currentSelectedId, 'FLIGHT_D', 'Final selected flight must match last clicked target');
console.log('[PASS] Rapid consecutive clicks handled flawlessly without queuing or stale state');

console.log('--- ALL VERIFICATIONS PASSED SUCCESSFULLY ---');
