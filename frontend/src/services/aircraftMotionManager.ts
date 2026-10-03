import {
  Cartesian3,
  Quaternion,
  HeadingPitchRoll,
  Transforms,
  Math as CesiumMath,
  Ellipsoid,
  SampledPositionProperty,
  LinearApproximation,
  ExtrapolationType,
  JulianDate,
  TimeInterval,
  CallbackProperty,
  PositionProperty,
  Property
} from 'cesium';

export interface MotionUpdateOptions {
  icao24: string;
  lat: number;
  lng: number;
  altitudeFt: number;
  headingDeg: number;
  speedKnots: number;
  durationSec?: number;
  currentTime?: JulianDate;
}

export interface AircraftMotionEntry {
  icao24: string;
  sampledPosition: SampledPositionProperty;
  lastUpdateTime: JulianDate;
  targetTime: JulianDate;
  startLat: number;
  startLng: number;
  startAltFt: number;
  startHeading: number;
  targetLat: number;
  targetLng: number;
  targetAltFt: number;
  targetHeading: number;
  speedKnots: number;
  durationSec: number;
  positionProp: PositionProperty;
  orientationProp: Property;
  rotationProp: Property;
  cachedPosition: Cartesian3;
}

export interface FlightMotionProps {
  positionProp: PositionProperty;
  orientationProp: Property;
  rotationProp: Property;
}

export class AircraftMotionManager {
  private registry = new Map<string, AircraftMotionEntry>();
  private showcaseMode: boolean = true;
  private reduceMotion: boolean = false;
  private viewerClockSupplier: (() => JulianDate | undefined) | null = null;

  // Reusable scratch variables to eliminate per-frame object allocation and GC pauses
  private scratchCartesian = new Cartesian3();
  private scratchQuaternion = new Quaternion();
  private scratchHPR = new HeadingPitchRoll();
  private scratchJulian = new JulianDate();

  public setShowcaseMode(enabled: boolean) {
    this.showcaseMode = enabled;
  }

  public setReduceMotion(enabled: boolean) {
    this.reduceMotion = enabled;
  }

  public setViewerClockSupplier(supplier: () => JulianDate | undefined) {
    this.viewerClockSupplier = supplier;
  }

  public getCurrentTime(): JulianDate {
    if (this.viewerClockSupplier) {
      const viewerTime = this.viewerClockSupplier();
      if (viewerTime) return JulianDate.clone(viewerTime);
    }
    return JulianDate.now();
  }

  public updatePosition(options: MotionUpdateOptions): AircraftMotionEntry {
    const {
      icao24,
      lat,
      lng,
      altitudeFt,
      headingDeg,
      speedKnots,
      durationSec = 8
    } = options;

    const now = options.currentTime ? JulianDate.clone(options.currentTime) : this.getCurrentTime();
    const altMeters = altitudeFt * 0.3048;
    const targetCartesian = Cartesian3.fromDegrees(lng, lat, altMeters);
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

      // Seed initial samples: anchor at current time and target time
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
        cachedPosition: Cartesian3.clone(targetCartesian),
        positionProp: null as any,
        orientationProp: null as any,
        rotationProp: null as any
      };

      this.bindProperties(entry);
      this.registry.set(icao24, entry);
      return entry;
    }

    // Check if coordinates and heading are identical to existing target
    if (
      entry.targetLat === lat &&
      entry.targetLng === lng &&
      entry.targetAltFt === altitudeFt &&
      entry.targetHeading === headingDeg
    ) {
      entry.speedKnots = speedKnots;
      return entry;
    }

    // Smooth continuous interpolation:
    // Evaluate the aircraft's current interpolated position at `now` to prevent snapping
    let currentInterpPos = entry.sampledPosition.getValue(now, this.scratchCartesian);
    if (!currentInterpPos) {
      currentInterpPos = Cartesian3.fromDegrees(entry.targetLng, entry.targetLat, entry.targetAltFt * 0.3048, Ellipsoid.WGS84, this.scratchCartesian);
    }

    // Calculate current interpolated heading at `now`
    const prevElapsedSec = Math.max(0, JulianDate.secondsDifference(now, entry.lastUpdateTime));
    const prevP = Math.min(1.0, Math.max(0, prevElapsedSec / (entry.durationSec || 8)));
    const prevDiff = ((entry.targetHeading - entry.startHeading + 540) % 360) - 180;
    const currentHeading = (entry.startHeading + prevDiff * prevP + 360) % 360;

    // Prune stale samples older than 45 seconds to bound memory
    const pruneCutoff = JulianDate.addSeconds(now, -45, this.scratchJulian);
    entry.sampledPosition.removeSamples(new TimeInterval({
      start: JulianDate.fromIso8601('1970-01-01T00:00:00Z'),
      stop: pruneCutoff
    }));

    if (!this.showcaseMode || this.reduceMotion) {
      // Instant snap when Showcase Mode is OFF or Reduce Motion is ON
      entry.sampledPosition.addSample(now, targetCartesian);
      entry.startHeading = headingDeg;
      entry.targetHeading = headingDeg;
    } else {
      // Continuous smooth interpolation:
      // 1. Anchor current interpolated position at `now`
      entry.sampledPosition.addSample(now, Cartesian3.clone(currentInterpPos));
      // 2. Set new target position at `targetTime`
      entry.sampledPosition.addSample(targetTime, targetCartesian);

      entry.startHeading = currentHeading;
      entry.targetHeading = headingDeg;
    }

    entry.startLat = lat;
    entry.startLng = lng;
    entry.startAltFt = altitudeFt;
    entry.targetLat = lat;
    entry.targetLng = lng;
    entry.targetAltFt = altitudeFt;
    entry.lastUpdateTime = JulianDate.clone(now);
    entry.targetTime = JulianDate.clone(targetTime);
    entry.durationSec = durationSec;
    entry.speedKnots = speedKnots;
    entry.cachedPosition = Cartesian3.clone(targetCartesian);

    return entry;
  }

  public getProperties(
    icao24: string,
    lat: number,
    lng: number,
    altitudeFt: number,
    headingDeg: number,
    speedKnots: number,
    _history?: Array<{ lat: number; lng: number }>
  ): FlightMotionProps {
    let entry = this.registry.get(icao24);
    if (!entry) {
      entry = this.updatePosition({
        icao24,
        lat,
        lng,
        altitudeFt,
        headingDeg,
        speedKnots,
        durationSec: 8
      });
    }

    return {
      positionProp: entry.positionProp,
      orientationProp: entry.orientationProp,
      rotationProp: entry.rotationProp
    };
  }

  public getInterpolatedHeading(icao24: string, time?: JulianDate): number {
    const entry = this.registry.get(icao24);
    if (!entry) return 0;
    const t = time || this.getCurrentTime();
    const elapsedSec = Math.max(0, JulianDate.secondsDifference(t, entry.lastUpdateTime));
    const duration = Math.max(1, entry.durationSec);
    const p = Math.min(1.0, Math.max(0, elapsedSec / duration));
    const diff = ((entry.targetHeading - entry.startHeading + 540) % 360) - 180;
    return (entry.startHeading + diff * p + 360) % 360;
  }

  public getInterpolatedPosition(icao24: string, time?: JulianDate): Cartesian3 | undefined {
    const entry = this.registry.get(icao24);
    if (!entry) return undefined;
    const t = time || this.getCurrentTime();
    return entry.sampledPosition.getValue(t);
  }

  public has(icao24: string): boolean {
    return this.registry.has(icao24);
  }

  public remove(icao24: string): void {
    this.registry.delete(icao24);
  }

  public prune(activeIcaos: Set<string>) {
    for (const [id] of this.registry) {
      if (!activeIcaos.has(id)) {
        this.registry.delete(id);
      }
    }
  }

  private bindProperties(entry: AircraftMotionEntry) {
    // 1. Direct SampledPositionProperty for high-performance Cesium interpolation
    entry.positionProp = entry.sampledPosition;

    // 2. Smooth Orientation with Shortest-Angle Heading, Turn Banking, and Climb/Descent Pitch
    entry.orientationProp = new CallbackProperty((time?: JulianDate) => {
      try {
        if (!this.registry.has(entry.icao24)) {
          return Transforms.headingPitchRollQuaternion(
            entry.cachedPosition || Cartesian3.ZERO,
            this.scratchHPR,
            Ellipsoid.WGS84,
            undefined,
            this.scratchQuaternion
          );
        }

        const t = time || this.getCurrentTime();

        if (!this.showcaseMode || this.reduceMotion) {
          this.scratchHPR.heading = CesiumMath.toRadians(entry.targetHeading || 0);
          this.scratchHPR.pitch = 0;
          this.scratchHPR.roll = 0;
          return Transforms.headingPitchRollQuaternion(
            entry.cachedPosition,
            this.scratchHPR,
            Ellipsoid.WGS84,
            undefined,
            this.scratchQuaternion
          );
        }

        const elapsedSec = Math.max(0, JulianDate.secondsDifference(t, entry.lastUpdateTime));
        const duration = Math.max(1, entry.durationSec);
        const p = Math.min(1.0, Math.max(0, elapsedSec / duration));

        // Compute shortest angular heading delta
        const diff = ((entry.targetHeading - entry.startHeading + 540) % 360) - 180;
        const currentHeading = (entry.startHeading + diff * p + 360) % 360;

        // Rate of turn (deg/s)
        const turnRate = diff / duration;

        // Banking dynamics: right turn dips right wing (+roll in Cesium ENU), left turn dips left wing (-roll)
        const turnEnvelope = Math.sin(Math.PI * Math.min(1.0, p));
        const targetBankDeg = Math.max(-35, Math.min(35, turnRate * 7.0));
        const bankDeg = Math.abs(diff) > 1.5 ? targetBankDeg * turnEnvelope : 0;

        // Climb / descent pitch dynamics
        const altDiff = entry.targetAltFt - entry.startAltFt;
        const fpm = (altDiff / duration) * 60; // feet per minute
        const pitchDeg = Math.max(-12, Math.min(15, fpm / 350));

        const currentPos = entry.sampledPosition?.getValue(t, this.scratchCartesian) || entry.cachedPosition;

        this.scratchHPR.heading = CesiumMath.toRadians(currentHeading);
        this.scratchHPR.pitch = CesiumMath.toRadians(pitchDeg);
        this.scratchHPR.roll = CesiumMath.toRadians(bankDeg);

        return Transforms.headingPitchRollQuaternion(
          currentPos,
          this.scratchHPR,
          Ellipsoid.WGS84,
          undefined,
          this.scratchQuaternion
        );
      } catch {
        return Transforms.headingPitchRollQuaternion(
          entry.cachedPosition || Cartesian3.ZERO,
          this.scratchHPR,
          Ellipsoid.WGS84,
          undefined,
          this.scratchQuaternion
        );
      }
    }, false);

    // 3. Smooth Heading in Radians (for 2D icons / billboards)
    entry.rotationProp = new CallbackProperty((time?: JulianDate) => {
      try {
        if (!this.registry.has(entry.icao24)) {
          return -CesiumMath.toRadians(entry.targetHeading || 0);
        }
        const t = time || this.getCurrentTime();
        if (!this.showcaseMode || this.reduceMotion) {
          return -CesiumMath.toRadians(entry.targetHeading || 0);
        }
        const elapsedSec = Math.max(0, JulianDate.secondsDifference(t, entry.lastUpdateTime));
        const duration = Math.max(1, entry.durationSec);
        const p = Math.min(1.0, Math.max(0, elapsedSec / duration));
        const diff = ((entry.targetHeading - entry.startHeading + 540) % 360) - 180;
        const currentHeading = (entry.startHeading + diff * p + 360) % 360;
        return -CesiumMath.toRadians(currentHeading);
      } catch {
        return -CesiumMath.toRadians(entry.targetHeading || 0);
      }
    }, false);

  }
}

// Singleton global manager instance for the application
export const aircraftMotionManager = new AircraftMotionManager();
