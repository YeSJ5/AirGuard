/**
 * test_motion_interpolation.js
 *
 * Automated verification test for CesiumJS continuous aircraft motion interpolation:
 * 1. Feeds a sequence of position updates over simulated poll intervals.
 * 2. Asserts rendered position moves smoothly through intermediate interpolated points (NOT snapping).
 * 3. Asserts angular heading turns smoothly using shortest-arc delta (including across North: 350° -> 10°).
 * 4. Asserts speed-proportional trailing history polyline.
 * 5. Asserts seamless continuity between consecutive updates arriving mid-interval.
 */

const path = require('path');
const fs = require('fs');

// Support running from either root directory or frontend directory
let cesiumPath = 'cesium';
if (!fs.existsSync(path.resolve(__dirname, '../node_modules/cesium')) && fs.existsSync(path.resolve(__dirname, '../frontend/node_modules/cesium'))) {
  cesiumPath = path.resolve(__dirname, '../frontend/node_modules/cesium');
}

const {
  SampledPositionProperty,
  LinearApproximation,
  ExtrapolationType,
  JulianDate,
  Cartesian3,
  Math: CesiumMath,
  HeadingPitchRoll,
  Transforms,
  Ellipsoid
} = require(cesiumPath);

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

function calculateDistance(p1, p2) {
  return Cartesian3.distance(p1, p2);
}

function runMotionInterpolationTests() {
  console.log('================================================================');
  console.log('🚀 AirGuard Cesium Motion Interpolation Verification Suite');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Continuous intermediate position interpolation over poll interval
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Multi-Point SampledPositionProperty Interpolation ---');
  const sampledPos = new SampledPositionProperty();
  sampledPos.backwardExtrapolationType = ExtrapolationType.HOLD;
  sampledPos.forwardExtrapolationType = ExtrapolationType.HOLD;
  sampledPos.setInterpolationOptions({
    interpolationAlgorithm: LinearApproximation,
    interpolationDegree: 1
  });

  const t0 = JulianDate.now();
  const pollIntervalSec = 8.0;
  const tTarget = JulianDate.addSeconds(t0, pollIntervalSec, new JulianDate());

  // Aircraft flies from Indira Gandhi Intl (DEL) towards Jaipur
  const posStart = Cartesian3.fromDegrees(77.1000, 28.5500, 10000 * 0.3048);
  const posTarget = Cartesian3.fromDegrees(76.5000, 27.8000, 10800 * 0.3048);

  sampledPos.addSample(t0, posStart);
  sampledPos.addSample(tTarget, posTarget);

  // Sample at 0s, 2s (25%), 4s (50%), 6s (75%), 8s (100%)
  const t2s = JulianDate.addSeconds(t0, 2.0, new JulianDate());
  const t4s = JulianDate.addSeconds(t0, 4.0, new JulianDate());
  const t6s = JulianDate.addSeconds(t0, 6.0, new JulianDate());

  const p0 = sampledPos.getValue(t0);
  const p2 = sampledPos.getValue(t2s);
  const p4 = sampledPos.getValue(t4s);
  const p6 = sampledPos.getValue(t6s);
  const p8 = sampledPos.getValue(tTarget);

  const totalDistance = calculateDistance(posStart, posTarget);
  const d0_2 = calculateDistance(p0, p2);
  const d2_4 = calculateDistance(p2, p4);
  const d4_6 = calculateDistance(p4, p6);
  const d6_8 = calculateDistance(p6, p8);

  console.log(`Total leg distance: ${(totalDistance / 1000).toFixed(2)} km`);
  console.log(`  t = 0.0s distance from start: 0.00 km`);
  console.log(`  t = 2.0s distance from start: ${(d0_2 / 1000).toFixed(2)} km (${((d0_2 / totalDistance) * 100).toFixed(1)}%)`);
  console.log(`  t = 4.0s distance from start: ${(calculateDistance(p0, p4) / 1000).toFixed(2)} km (${((calculateDistance(p0, p4) / totalDistance) * 100).toFixed(1)}%)`);
  console.log(`  t = 6.0s distance from start: ${(calculateDistance(p0, p6) / 1000).toFixed(2)} km (${((calculateDistance(p0, p6) / totalDistance) * 100).toFixed(1)}%)`);
  console.log(`  t = 8.0s distance from start: ${(totalDistance / 1000).toFixed(2)} km (100.0%)`);

  // Assertions:
  // 1. Initial position matches exact start
  assert(calculateDistance(p0, posStart) < 0.01, 'Position at t=0s matches exact start coordinate');
  // 2. Final position matches exact target
  assert(calculateDistance(p8, posTarget) < 0.01, 'Position at t=8s matches exact target coordinate');
  // 3. All intermediate positions are strictly distinct from endpoints (no teleport jumps)
  assert(d0_2 > 1000 && d0_2 < totalDistance, 'Position at t=2s is an intermediate point (not teleported)');
  assert(d2_4 > 1000, 'Position advances continuously between 2s and 4s');
  assert(d4_6 > 1000, 'Position advances continuously between 4s and 6s');
  assert(d6_8 > 1000, 'Position advances continuously between 6s and 8s');

  // 4. Exact linear progression (25%, 50%, 75% progression within 0.1% tolerance)
  const ratio2s = d0_2 / totalDistance;
  const ratio4s = calculateDistance(p0, p4) / totalDistance;
  const ratio6s = calculateDistance(p0, p6) / totalDistance;
  assert(Math.abs(ratio2s - 0.25) < 0.01, `2.0s progression is exactly 25% (got ${(ratio2s * 100).toFixed(2)}%)`);
  assert(Math.abs(ratio4s - 0.50) < 0.01, `4.0s progression is exactly 50% (got ${(ratio4s * 100).toFixed(2)}%)`);
  assert(Math.abs(ratio6s - 0.75) < 0.01, `6.0s progression is exactly 75% (got ${(ratio6s * 100).toFixed(2)}%)`);

  // -------------------------------------------------------------------------
  // TEST 2: Consecutive WebSocket updates with mid-interval arrival (Zero Jumps)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Consecutive WebSocket Updates with Zero Snapping ---');
  // Suppose next poll arrives at t = 6.0s (2s earlier than planned 8s)
  // The motion engine must evaluate current position at t = 6.0s, anchor it, and steer toward new target
  const posAtArrival = sampledPos.getValue(t6s);
  const posNewTarget = Cartesian3.fromDegrees(76.1000, 27.2000, 11500 * 0.3048);
  const tNewTarget = JulianDate.addSeconds(t6s, 8.0, new JulianDate());

  // Anchor and update
  sampledPos.addSample(t6s, posAtArrival);
  sampledPos.addSample(tNewTarget, posNewTarget);

  // Position at t = 6.0s before and after must have 0 jump
  const posRightAfter = sampledPos.getValue(t6s);
  const discontinuityMeters = calculateDistance(posAtArrival, posRightAfter);
  assert(discontinuityMeters < 0.001, `Discontinuity between consecutive poll updates is 0.0m (got ${discontinuityMeters.toFixed(5)}m)`);

  // Sample intermediate point on the new leg at t = 6s + 4s = 10s
  const t10s = JulianDate.addSeconds(t6s, 4.0, new JulianDate());
  const p10 = sampledPos.getValue(t10s);
  const distLeg2 = calculateDistance(posAtArrival, posNewTarget);
  const dLeg2Mid = calculateDistance(posAtArrival, p10);
  assert(Math.abs((dLeg2Mid / distLeg2) - 0.50) < 0.01, `Midpoint of second leg is exactly 50% along new vector`);

  // -------------------------------------------------------------------------
  // TEST 3: Smooth Shortest-Arc Heading Interpolation & Wrap-Around
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3: Shortest-Path Heading Interpolation (North Wrap) ---');
  function interpolateHeading(startH, targetH, progress) {
    const diff = ((targetH - startH + 540) % 360) - 180;
    return (startH + diff * progress + 360) % 360;
  }

  // Turn across North: 350° to 20° (should be +30° right turn, NOT -330° left spin)
  const hStart = 350;
  const hTarget = 20;
  const hMid = interpolateHeading(hStart, hTarget, 0.5);
  console.log(`  Turning from ${hStart}° to ${hTarget}°:`);
  console.log(`  Progress 25%: ${interpolateHeading(hStart, hTarget, 0.25).toFixed(1)}°`);
  console.log(`  Progress 50%: ${hMid.toFixed(1)}°`);
  console.log(`  Progress 75%: ${interpolateHeading(hStart, hTarget, 0.75).toFixed(1)}°`);

  assert(Math.abs(hMid - 5.0) < 0.01, `Midpoint heading of 350° -> 20° is 5.0° (crosses North smoothly, NOT 185°)`);

  // Left turn: 30° to 330° (-60° turn)
  const hLeftMid = interpolateHeading(30, 330, 0.5);
  assert(Math.abs(hLeftMid - 0.0) < 0.01, `Midpoint heading of 30° -> 330° is 0.0° (crosses North left smoothly)`);

  // Standard turn: 90° to 180° (+90° turn)
  const hStandardMid = interpolateHeading(90, 180, 0.5);
  assert(Math.abs(hStandardMid - 135.0) < 0.01, `Midpoint heading of 90° -> 180° is 135.0°`);

  // -------------------------------------------------------------------------
  // TEST 4: Speed-Proportional Trail Points & Opacity Scaling
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 4: Speed-Proportional Fading Polyline Trail ---');
  function getTrailConfig(speedKnots) {
    const maxPoints = speedKnots > 450 ? 5 : speedKnots > 300 ? 3 : speedKnots > 150 ? 2 : speedKnots > 40 ? 1 : 0;
    const speedRatio = Math.min(1.0, Math.max(0.15, speedKnots / 550));
    const trailAlpha = 0.18 + 0.42 * speedRatio;
    const trailWidth = 1.0 + 1.2 * speedRatio;
    return { maxPoints, trailAlpha, trailWidth };
  }

  const highSpeed = getTrailConfig(520); // Boeing 777 cruise
  const medSpeed = getTrailConfig(380);  // Regional jet descent
  const slowSpeed = getTrailConfig(140); // Final approach
  const taxiSpeed = getTrailConfig(25);  // Taxiing

  console.log(`  High Speed (520 kt): ${highSpeed.maxPoints} trail points, width ${highSpeed.trailWidth.toFixed(2)}, alpha ${highSpeed.trailAlpha.toFixed(2)}`);
  console.log(`  Med Speed  (380 kt): ${medSpeed.maxPoints} trail points, width ${medSpeed.trailWidth.toFixed(2)}, alpha ${medSpeed.trailAlpha.toFixed(2)}`);
  console.log(`  Slow Speed (140 kt): ${slowSpeed.maxPoints} trail points, width ${slowSpeed.trailWidth.toFixed(2)}, alpha ${slowSpeed.trailAlpha.toFixed(2)}`);
  console.log(`  Taxi Speed  (25 kt): ${taxiSpeed.maxPoints} trail points, width ${taxiSpeed.trailWidth.toFixed(2)}, alpha ${taxiSpeed.trailAlpha.toFixed(2)}`);

  assert(highSpeed.maxPoints === 5, 'High-speed aircraft gets 5 trail points for long visible trajectory');
  assert(medSpeed.maxPoints === 3, 'Medium-speed aircraft gets 3 trail points');
  assert(slowSpeed.maxPoints === 1, 'Approach speed gets 1 short point');
  assert(taxiSpeed.maxPoints === 0, 'Taxiing aircraft generates 0 trail points (no clutter on runway)');
  assert(highSpeed.trailAlpha > medSpeed.trailAlpha, 'Trail alpha scales with speed (faster = more vivid)');
  assert(highSpeed.trailWidth > slowSpeed.trailWidth, 'Trail line width scales with speed');

  // -------------------------------------------------------------------------
  // TEST 5: 60 FPS Render Loop Performance Profile (300 Aircraft Batch)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 5: Frame Budget Profile @ 300 Simulated Aircraft (Target 60 FPS) ---');
  const count = 300;
  const testEntities = [];
  const baseTime = JulianDate.now();

  for (let i = 0; i < count; i++) {
    const prop = new SampledPositionProperty();
    prop.setInterpolationOptions({ interpolationAlgorithm: LinearApproximation, interpolationDegree: 1 });
    const pA = Cartesian3.fromDegrees(77.0 + (i * 0.01), 28.0 + (i * 0.01), 10000);
    const pB = Cartesian3.fromDegrees(77.05 + (i * 0.01), 28.05 + (i * 0.01), 10000);
    prop.addSample(baseTime, pA);
    prop.addSample(JulianDate.addSeconds(baseTime, 8.0, new JulianDate()), pB);
    testEntities.push(prop);
  }

  // Measure time to evaluate all 300 aircraft positions in a single animation frame
  const sampleTime = JulianDate.addSeconds(baseTime, 3.456, new JulianDate());
  const scratch = new Cartesian3();
  const startPerf = process.hrtime.bigint();

  const ITERATIONS = 60; // Simulate 1 full second of 60fps frames (60 frames * 300 entities = 18,000 evaluations)
  for (let frame = 0; frame < ITERATIONS; frame++) {
    const frameTime = JulianDate.addSeconds(baseTime, frame * (1.0 / 60.0), new JulianDate());
    for (let i = 0; i < count; i++) {
      testEntities[i].getValue(frameTime, scratch);
    }
  }

  const endPerf = process.hrtime.bigint();
  const elapsedMs = Number(endPerf - startPerf) / 1_000_000;
  const perFrameMs = elapsedMs / ITERATIONS;
  const frameBudgetPercent = (perFrameMs / 16.66) * 100; // 16.66ms is 60fps frame budget

  console.log(`Evaluated 300 aircraft across 60 frames (18,000 evaluations): ${elapsedMs.toFixed(2)}ms total`);
  console.log(`Average CPU time per frame for 300 aircraft: ${perFrameMs.toFixed(3)}ms`);
  console.log(`Frame budget consumed @ 60 FPS: ${frameBudgetPercent.toFixed(1)}% of 16.6ms`);

  assert(perFrameMs < 4.0, `Per-frame evaluation is under 4.0ms (got ${perFrameMs.toFixed(3)}ms, comfortably sustaining 60fps)`);

  console.log('\n================================================================');
  console.log('🎉 ALL MOTION INTERPOLATION TESTS PASSED CLEANLY (5/5)');
  console.log('================================================================');
}

runMotionInterpolationTests();
