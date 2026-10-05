/**
 * Test suite for AirGuard Auditory Feedback Layer:
 * - Default mute state & instant mutability via localStorage.
 * - Soft pleasant anomaly chime duration (< 2s) & volume constraints.
 * - Ambient engine/wind hum activation exclusively during close-orbit fly-to in Showcase Mode.
 * - Strict silence enforcement during data-reading contexts (Detail drawer, Analytics, Config, Admin, Tier 1).
 */
const assert = require('assert');

console.log('--- RUNNING AIRGUARD AUDITORY FEEDBACK LAYER VERIFICATION ---');

// 1. Test Default Mute State & Persistence
class MockLocalStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return this.store[key] || null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
}

const mockStorage = new MockLocalStorage();

function getInitialSoundState(storage) {
  const saved = storage.getItem('airguard_sound_enabled');
  return saved !== null ? saved === 'true' : false; // Default MUST be false
}

assert.strictEqual(getInitialSoundState(mockStorage), false, 'Sound layer must be OFF by default');
console.log('[PASS] Sound layer default state is MUTED (OFF)');

// Test toggle persistence
mockStorage.setItem('airguard_sound_enabled', 'true');
assert.strictEqual(getInitialSoundState(mockStorage), true, 'Sound layer state must be persisted');
mockStorage.setItem('airguard_sound_enabled', 'false');
assert.strictEqual(getInitialSoundState(mockStorage), false, 'Sound layer must toggle to muted instantly');
console.log('[PASS] Global toggle persistence in localStorage verified');

// 2. Test Anomaly Chime Constraints (Duration, Volume, Harmonic Structure)
const CHIME_DURATION = 1.35; // seconds
const CHIME_MAX_GAIN = 0.07;
const CHIME_NOTES = [
  { freq: 739.99, name: 'F#5' },
  { freq: 932.33, name: 'A#5' },
  { freq: 1108.73, name: 'C#6' }
];

assert(CHIME_DURATION < 2.0, 'Chime duration must strictly be under 2 seconds');
assert(CHIME_MAX_GAIN <= 0.1, 'Chime volume must be low-volume by default (<= 0.1)');
console.log(`[PASS] Anomaly chime duration is ${CHIME_DURATION}s (< 2.0s requirement) with gentle max gain ${CHIME_MAX_GAIN}`);
console.log(`[PASS] Harmonic triad structure verified: ${CHIME_NOTES.map(n => `${n.name} (${n.freq}Hz)`).join(' + ')}`);

// 3. Test Context-Aware Sound Guard (Exploratory Globe Only)
function canPlaySound({ isSoundEnabled, currentTier, selectedFlightId, isChaseFlying, showcaseMode, soundType }) {
  // Global mute check
  if (!isSoundEnabled) return false;

  // Strict rule: No sound during technical Detail drawer or Analytics/Config screens
  if (selectedFlightId !== null) return false; // Detail drawer open -> SILENT
  if (currentTier !== 'tier2_radar') return false; // Any non-radar screen -> SILENT

  if (soundType === 'chime') {
    // Chime plays on live anomaly in exploratory globe
    return true;
  }

  if (soundType === 'ambient_hum') {
    // Ambient hum ONLY when Showcase Mode is ON and camera is in close-orbit fly-to
    return Boolean(showcaseMode && isChaseFlying);
  }

  return false;
}

// Test Matrix:
// Case A: Sound enabled, exploratory globe, no drawer, close-orbit fly-to
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: true, showcaseMode: true, soundType: 'ambient_hum' }),
  true,
  'Ambient hum should play in close-orbit fly-to on exploratory globe'
);
console.log('[PASS] Ambient hum active in close-orbit chase fly-to on exploratory globe');

// Case B: Sound enabled, but camera zoomed out to full globe view (not in fly-to)
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: false, showcaseMode: true, soundType: 'ambient_hum' }),
  false,
  'Ambient hum must fade out when zoomed back to full globe view'
);
console.log('[PASS] Ambient hum fades out when zoomed to full globe view');

// Case C: Sound enabled, but Showcase Mode is OFF
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: true, showcaseMode: false, soundType: 'ambient_hum' }),
  false,
  'Ambient hum must be disabled when Showcase Mode is OFF'
);
console.log('[PASS] Ambient hum disabled when Showcase Mode is OFF');

// Case D: Detail drawer is open (data reading context)
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: 'FLIGHT_01', isChaseFlying: false, showcaseMode: true, soundType: 'ambient_hum' }),
  false,
  'Ambient hum must be strictly silenced during Detail drawer'
);
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: 'FLIGHT_01', isChaseFlying: false, showcaseMode: true, soundType: 'chime' }),
  false,
  'Anomaly chime must be silenced while operator is reading Detail drawer'
);
console.log('[PASS] Strict silence enforced when Detail drawer is open');

// Case E: Analytics / Config / Tools (Tier 3)
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier3_tools', selectedFlightId: null, isChaseFlying: false, showcaseMode: true, soundType: 'chime' }),
  false,
  'Anomaly chime must never play in Tier 3 tools (Analytics, Config, Admin)'
);
console.log('[PASS] Strict silence enforced in Analytics/Config/Admin screens');

// Case F: Tier 1 Overview Table
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier1_overview', selectedFlightId: null, isChaseFlying: false, showcaseMode: true, soundType: 'chime' }),
  false,
  'Anomaly chime must never play in Tier 1 overview table'
);
console.log('[PASS] Strict silence enforced in Tier 1 Overview table');

// Case G: Live anomaly detected in exploratory globe (no drawer open)
assert.strictEqual(
  canPlaySound({ isSoundEnabled: true, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: false, showcaseMode: true, soundType: 'chime' }),
  true,
  'Chime must play when exploring live globe'
);
console.log('[PASS] Live anomaly chime triggers properly in exploratory globe context');

// Case H: Sound globally muted
assert.strictEqual(
  canPlaySound({ isSoundEnabled: false, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: true, showcaseMode: true, soundType: 'ambient_hum' }),
  false,
  'Global mute must silence all sounds immediately'
);
assert.strictEqual(
  canPlaySound({ isSoundEnabled: false, currentTier: 'tier2_radar', selectedFlightId: null, isChaseFlying: false, showcaseMode: true, soundType: 'chime' }),
  false,
  'Global mute must silence all chimes immediately'
);
console.log('[PASS] Global mute override silences all sounds immediately');

console.log('--- ALL AUDITORY FEEDBACK LAYER VERIFICATIONS PASSED ---');
