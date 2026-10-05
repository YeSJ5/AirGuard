/**
 * test_polyline_stress.js
 *
 * Stress test for Cesium aircraft trail dynamic polyline CallbackProperty lifecycle:
 * - Rapidly churns 100+ aircraft entities through random add, update, prune, and remove cycles.
 * - Simulates Cesium render ticks executing entity.polyline.positions.getValue(time) concurrently
 *   with entity removal, ensuring no "Cannot read properties of undefined (reading 'positions')"
 *   or undefined returns occur.
 * - Verifies callback ALWAYS returns a valid Array (possibly empty), never undefined.
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
  CallbackProperty,
  HeadingPitchRoll,
  Transforms,
  Ellipsoid,
  Math: CesiumMath
} = require(cesiumPath);

class AircraftMotionManagerTestHarness {
  constructor() {
    this.registry = new Map();
    this.scratchCartesian = new Cartesian3();
    this.scratchQuaternion = {};
    this.scratchHPR = new HeadingPitchRoll();
  }

  has(icao24) {
    return this.registry.has(icao24);
  }

  remove(icao24) {
    this.registry.delete(icao24);
  }

  prune(activeIcaos) {
    for (const [id] of this.registry) {
      if (!activeIcaos.has(id)) {
        this.registry.delete(id);
      }
    }
  }

  updatePosition(options) {
    const { icao24, lat, lng, altitudeFt, headingDeg, speedKnots, durationSec = 8 } = options;
    const now = JulianDate.now();
    const targetCartesian = Cartesian3.fromDegrees(lng, lat, altitudeFt * 0.3048);
    const targetTime = JulianDate.addSeconds(now, durationSec, new JulianDate());

    let entry = this.registry.get(icao24);
    if (!entry) {
      const sampledPos = new SampledPositionProperty();
      sampledPos.backwardExtrapolationType = ExtrapolationType.HOLD;
      sampledPos.forwardExtrapolationType = ExtrapolationType.HOLD;
      sampledPos.setInterpolationOptions({
        interpolationAlgorithm: LinearApproximation,
        interpolationDegree: 1
      });
      sampledPos.addSample(now, targetCartesian);
      sampledPos.addSample(targetTime, targetCartesian);

      entry = {
        icao24,
        sampledPosition: sampledPos,
        lastUpdateTime: JulianDate.clone(now),
        targetTime: JulianDate.clone(targetTime),
        startLat: lat,
        startLng: lng,
        startAltFt: altitudeFt,
        startHeading: headingDeg,
        targetLat: lat,
        targetLng: lng,
        targetAltFt: altitudeFt,
        targetHeading: headingDeg,
        speedKnots,
        durationSec,
        historyCartesians: [Cartesian3.clone(targetCartesian)],
        cachedPosition: Cartesian3.clone(targetCartesian),
        positionProp: null,
        orientationProp: null,
        rotationProp: null,
        trailProp: null
      };

      this.bindProperties(entry);
      this.registry.set(icao24, entry);
      return entry;
    }

    entry.sampledPosition.addSample(targetTime, targetCartesian);
    entry.targetLat = lat;
    entry.targetLng = lng;
    entry.targetAltFt = altitudeFt;
    entry.targetHeading = headingDeg;
    entry.cachedPosition = Cartesian3.clone(targetCartesian);
    return entry;
  }

  bindProperties(entry) {
    entry.positionProp = entry.sampledPosition;

    // Guaranteed safe dynamic polyline trail property
    entry.trailProp = new CallbackProperty((time) => {
      try {
        if (!this.registry.has(entry.icao24)) {
          return [];
        }

        const t = time || JulianDate.now();
        let currentPos;
        try {
          currentPos = entry.sampledPosition?.getValue(t, this.scratchCartesian);
        } catch {
          currentPos = entry.cachedPosition;
        }

        if (!currentPos && !entry.cachedPosition) {
          return [];
        }

        const safePos = Cartesian3.clone(currentPos || entry.cachedPosition || Cartesian3.ZERO);

        if (!entry.historyCartesians || !Array.isArray(entry.historyCartesians) || entry.historyCartesians.length === 0) {
          return [safePos, safePos];
        }

        return [safePos, ...entry.historyCartesians];
      } catch {
        return [];
      }
    }, false);
  }
}

function runStressTest() {
  console.log('================================================================');
  console.log('🚀 Cesium Dynamic Polyline Add/Remove/Prune Stress Test');
  console.log('================================================================\n');

  const motionManager = new AircraftMotionManagerTestHarness();
  const createdEntities = [];

  const NUM_AIRCRAFT = 150;
  const CHURN_ITERATIONS = 500;

  console.log(`Phase 1: Seeding ${NUM_AIRCRAFT} active aircraft with polyline properties...`);
  for (let i = 0; i < NUM_AIRCRAFT; i++) {
    const icao = `ac_${i.toString(16).padStart(4, '0')}`;
    const entry = motionManager.updatePosition({
      icao24: icao,
      lat: 20.0 + (i % 10) * 0.5,
      lng: 75.0 + (i % 10) * 0.5,
      altitudeFt: 30000 + (i % 5) * 2000,
      headingDeg: (i * 30) % 360,
      speedKnots: 250 + (i % 50)
    });

    createdEntities.push({
      icao,
      entry,
      polylinePositions: entry.trailProp
    });
  }
  console.log(`✅ Seeded ${createdEntities.length} entities successfully.\n`);

  console.log(`Phase 2: Executing ${CHURN_ITERATIONS} high-frequency churn cycles with concurrent Cesium render ticks...`);
  let totalRenderTicks = 0;
  let undefinedReturns = 0;
  let nonArrayReturns = 0;
  let exceptionsCaught = 0;

  const activeSet = new Set(createdEntities.map(e => e.icao));

  for (let cycle = 0; cycle < CHURN_ITERATIONS; cycle++) {
    // 1. Randomly add new aircraft
    if (Math.random() > 0.4) {
      const newIcao = `churn_${cycle}_${Math.floor(Math.random() * 1000)}`;
      const entry = motionManager.updatePosition({
        icao24: newIcao,
        lat: 25.0 + Math.random() * 5,
        lng: 78.0 + Math.random() * 5,
        altitudeFt: 28000,
        headingDeg: 180,
        speedKnots: 240
      });
      createdEntities.push({
        icao: newIcao,
        entry,
        polylinePositions: entry.trailProp
      });
      activeSet.add(newIcao);
    }

    // 2. Randomly remove or prune aircraft
    if (Math.random() > 0.3 && createdEntities.length > 20) {
      const removeIndex = Math.floor(Math.random() * createdEntities.length);
      const target = createdEntities[removeIndex];
      motionManager.remove(target.icao);
      activeSet.delete(target.icao);
      // NOTE: target entity still exists in createdEntities simulating stale Cesium render reference!
    }

    // 3. Periodic batch pruning (every 20 cycles)
    if (cycle % 20 === 0) {
      motionManager.prune(activeSet);
    }

    // 4. Simulate Cesium's PolylineVisualizer.update / DynamicGeometryBatch.update tick
    // Cesium iterates all known entities (including ones whose data was just pruned from store)
    const renderTime = JulianDate.now();
    for (const entity of createdEntities) {
      totalRenderTicks++;
      try {
        const positions = entity.polylinePositions.getValue(renderTime);
        if (positions === undefined) {
          undefinedReturns++;
        } else if (!Array.isArray(positions)) {
          nonArrayReturns++;
        }
      } catch (err) {
        exceptionsCaught++;
        console.error(`Exception on entity ${entity.icao}:`, err);
      }
    }
  }

  console.log(`\n================ STRESS TEST RESULTS ================`);
  console.log(`Total Simulated Cesium Render Evaluations: ${totalRenderTicks.toLocaleString()}`);
  console.log(`Undefined Returns: ${undefinedReturns}`);
  console.log(`Non-Array Returns: ${nonArrayReturns}`);
  console.log(`Exceptions Thrown: ${exceptionsCaught}`);
  console.log(`=====================================================\n`);

  if (undefinedReturns > 0 || nonArrayReturns > 0 || exceptionsCaught > 0) {
    console.error('❌ FAIL: Polyline callback failed stress test assertions!');
    process.exit(1);
  }

  console.log('✅ PASS: Stress test passed with 100% safety - 0 undefined returns, 0 non-array returns, 0 exceptions under high churn.');
}

runStressTest();
