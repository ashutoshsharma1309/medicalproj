#pragma once
/**
 * AVERIS wearable — signal processing.
 *
 * Header-only and free of every Arduino symbol, which is the point: this is
 * the code that decides whether a number is a measurement or noise, and code
 * that can only run on an ESP32 is code that only gets tested by wearing one.
 * `test/test_signal_core.cpp` compiles this file with the host compiler and
 * runs it against the same expectations the backend validators use.
 *
 * ── What lives here and what deliberately does not ─────────────────────────
 *
 * Here: filtering, plausibility, and the fall state machine — anything that
 * turns raw sensor output into a claim about a person.
 *
 * Not here: thresholds that decide something is *concerning*. The buzzer's
 * trigger levels are in `alert_levels.h` beside it, and the clinical rules
 * live on the server. A wearable that made clinical judgements would need to
 * be re-flashed to change one, and re-flashing a fleet of bands on someone's
 * wrist is not a deployment strategy.
 *
 * ── Why the ESP32 filters at all ───────────────────────────────────────────
 *
 * The MAX30102 reports a heart rate every time it thinks it has one, and a
 * finger shifting on the sensor produces 45 BPM, then 210, then 78, inside two
 * seconds. Shipping that to the server means the server stores it: the
 * plausibility check upstream only rejects the physically impossible, and 210
 * is entirely possible. The device is the only place that knows the reading
 * came from a sensor that had just lost contact.
 *
 * So the rule this file enforces: **the band sends what it believes, or it
 * sends nothing.** A gap in the series is honest and the dashboard renders it
 * as a gap. A wrong number is indistinguishable from a real one forever.
 */

#include <stdint.h>
#include <stddef.h>
#include <math.h>

namespace averis {

// ---------------------------------------------------------------------------
// Plausibility — mirrors PLAUSIBLE in lib/iot/reading-validation.ts and
// iot-service/app/validation.py, and the CHECK constraints behind both.
//
// Duplicated onto the device on purpose. The server rejects an impossible
// reading, but by then it has cost a radio transmission on a battery that has
// to last a day; the band should not spend power sending something it can
// already tell is a fault.
// ---------------------------------------------------------------------------
struct Range {
  float min;
  float max;
  bool contains(float v) const { return !isnan(v) && v >= min && v <= max; }
};

constexpr Range kHeartRate   = {20.0f, 250.0f};
constexpr Range kSpo2        = {50.0f, 100.0f};
constexpr Range kTemperature = {25.0f, 45.0f};
constexpr Range kBattery     = {0.0f, 100.0f};

/** Sentinel for "no measurement". NaN, never 0 — a zero reads as a value. */
constexpr float kNoValue = NAN;
inline bool hasValue(float v) { return !isnan(v); }

// ---------------------------------------------------------------------------
// Moving average with outlier rejection
//
// A plain mean is the wrong filter for this signal. One 210 BPM sample from a
// sensor that lost contact drags a 10-sample mean up by 13 BPM, and the result
// is a number that is wrong *and* looks calm — the worst combination, because
// nothing downstream can tell it from a real gentle rise.
//
// So a sample more than `tolerance` from the current median is not averaged
// in; it is dropped and counted. A run of them means the sensor is not on
// skin, which `rejectedRun()` reports so the caller can stop claiming a
// reading at all.
//
// **The escape hatch is load-bearing.** A filter that only ever rejects is not
// a filter, it is a lock: a wearer who starts running produces a genuine climb
// that outruns the tolerance, every sample gets rejected against a stale
// median, and the band reports a resting heart rate through a cardiac event.
// So `kResyncAfter` consecutive rejections are read as the signal having
// genuinely moved — the window is thrown away and rebuilt around the new
// level. Until three samples agree on it, the channel reports nothing, which
// is the honest state: something changed and the band does not yet know what
// to.
// ---------------------------------------------------------------------------
template <size_t N>
class SmoothedChannel {
 public:
  /** Consecutive rejections after which the signal is assumed to have moved. */
  static constexpr uint16_t kResyncAfter = 5;

  explicit SmoothedChannel(Range plausible, float tolerance)
      : plausible_(plausible), tolerance_(tolerance) {}

  /** Feeds one raw sample. Returns true when it was accepted. */
  bool push(float sample) {
    if (!plausible_.contains(sample)) {
      // Never a resync candidate. A run of physically impossible values is a
      // broken sensor, and rebuilding the window around 4000 BPM would turn a
      // fault into a baseline.
      rejected_++;
      return false;
    }

    // Until the window has something to compare against, everything plausible
    // is accepted: rejecting against an empty history would reject the first
    // real reading after every boot.
    if (count_ >= 3) {
      const float centre = median();
      if (fabsf(sample - centre) > tolerance_) {
        rejected_++;
        if (rejected_ >= kResyncAfter) {
          // Sustained disagreement with the window. Trust the sensor over the
          // history and start again from here.
          reset();
        } else {
          return false;
        }
      }
    }

    window_[head_] = sample;
    head_ = (head_ + 1) % N;
    if (count_ < N) count_++;
    rejected_ = 0;
    return true;
  }

  /** The filtered value, or kNoValue when the window is not yet trustworthy. */
  float value() const {
    // Three samples, not one. A single accepted reading after a run of
    // rejections is as likely to be the next artefact as the recovery.
    if (count_ < 3) return kNoValue;

    float sum = 0.0f;
    for (size_t i = 0; i < count_; i++) sum += window_[i];
    return sum / static_cast<float>(count_);
  }

  /** Consecutive rejected samples. A long run means "not on skin". */
  uint16_t rejectedRun() const { return rejected_; }

  size_t samples() const { return count_; }

  /**
   * Forgets everything.
   *
   * Called when the sensor reports loss of contact. The alternative — letting
   * the old window decay — means the band reports the wrist it was on ten
   * seconds ago, which is a measurement of nobody.
   */
  void reset() {
    count_ = 0;
    head_ = 0;
    rejected_ = 0;
  }

 private:
  float median() const {
    float sorted[N];
    for (size_t i = 0; i < count_; i++) sorted[i] = window_[i];
    // Insertion sort: N is 8 or 12 here, and qsort would cost more in stack
    // and code size than it saves.
    for (size_t i = 1; i < count_; i++) {
      float key = sorted[i];
      size_t j = i;
      while (j > 0 && sorted[j - 1] > key) {
        sorted[j] = sorted[j - 1];
        j--;
      }
      sorted[j] = key;
    }
    return count_ % 2 ? sorted[count_ / 2]
                      : (sorted[count_ / 2 - 1] + sorted[count_ / 2]) / 2.0f;
  }

  Range plausible_;
  float tolerance_;
  float window_[N] = {0};
  size_t head_ = 0;
  size_t count_ = 0;
  uint16_t rejected_ = 0;
};

// ---------------------------------------------------------------------------
// Movement and fall detection
//
// The MPU6050 gives acceleration in g and rotation in degrees per second. A
// fall is not "a big number" — a band dropped on a table produces a bigger
// impact peak than most human falls, and a phone in a pocket during a jog
// crosses 2g repeatedly.
//
// What distinguishes a fall is a *sequence*:
//
//     free-fall (magnitude collapses toward 0g)
//        ↓  within ~800ms
//     impact (a sharp peak)
//        ↓  then
//     stillness (no significant movement for a couple of seconds)
//
// All three, in order, inside a window. The stillness stage is what removes
// almost every false positive: someone who trips, catches themselves and keeps
// walking generates free-fall and impact and then keeps moving. That person
// does not need an ambulance, and a band that calls one anyway gets taken off.
//
// The cost is a deliberate ~2 second delay before a fall is reported. That is
// the right trade: this is not an airbag, and a fall that is reported two
// seconds late is still reported. A false alarm at 3am is not recoverable in
// the same way — it teaches the wearer to ignore the band.
// ---------------------------------------------------------------------------
enum class Movement : uint8_t {
  kUnknown = 0,
  kResting,
  kNormal,
  kActive,
  kFallSuspected,
};

/** The exact strings the wire contract accepts. */
inline const char* movementName(Movement m) {
  switch (m) {
    case Movement::kResting:       return "RESTING";
    case Movement::kNormal:        return "NORMAL";
    case Movement::kActive:        return "ACTIVE";
    case Movement::kFallSuspected: return "FALL_SUSPECTED";
    default:                       return "UNKNOWN";
  }
}

struct MotionThresholds {
  /** Below this total acceleration, the band is in free fall. */
  float freeFallG = 0.45f;
  /** Above this, something hit something. */
  float impactG = 2.6f;
  /** Deviation from 1g that still counts as "not moving". */
  float stillnessBandG = 0.18f;
  /** Above this the wearer is moving about rather than sitting. */
  float activeG = 0.28f;
  /** Free fall must be followed by impact within this. */
  uint32_t impactWindowMs = 900;
  /** Stillness required after impact before a fall is declared. */
  uint32_t stillnessMs = 2000;
  /** How long a declared fall keeps being reported. */
  uint32_t latchMs = 30000;
};

class FallDetector {
 public:
  explicit FallDetector(MotionThresholds thresholds = {}) : t_(thresholds) {}

  /**
   * Feeds one accelerometer sample.
   *
   * `magnitudeG` is the vector magnitude sqrt(x²+y²+z²) in g — 1.0 at rest.
   * `nowMs` is a monotonic millisecond clock (millis() on the device).
   */
  Movement update(float magnitudeG, uint32_t nowMs) {
    const float deviation = fabsf(magnitudeG - 1.0f);

    // A declared fall latches. Clearing it the moment the wearer twitches
    // would retract an emergency that a person is already responding to.
    if (latchedUntilMs_ != 0) {
      if (nowMs < latchedUntilMs_) return Movement::kFallSuspected;
      latchedUntilMs_ = 0;
      stage_ = Stage::kIdle;
    }

    switch (stage_) {
      case Stage::kIdle:
        if (magnitudeG < t_.freeFallG) {
          stage_ = Stage::kFreeFall;
          stageEnteredMs_ = nowMs;
        }
        break;

      case Stage::kFreeFall:
        if (magnitudeG > t_.impactG) {
          stage_ = Stage::kImpact;
          stageEnteredMs_ = nowMs;
        } else if (nowMs - stageEnteredMs_ > t_.impactWindowMs) {
          // Free fall with no impact. A band that was tossed onto a sofa, or
          // an arm swung downward fast enough to unload the sensor.
          stage_ = Stage::kIdle;
        }
        break;

      case Stage::kImpact:
        if (deviation > t_.stillnessBandG) {
          // Still moving after the impact. Someone who tripped and caught
          // themselves — the single most common false positive there is.
          stage_ = Stage::kIdle;
        } else if (nowMs - stageEnteredMs_ >= t_.stillnessMs) {
          stage_ = Stage::kIdle;
          latchedUntilMs_ = nowMs + t_.latchMs;
          falls_++;
          return Movement::kFallSuspected;
        }
        break;
    }

    if (deviation > t_.activeG) return Movement::kActive;
    if (deviation > t_.stillnessBandG) return Movement::kNormal;
    return Movement::kResting;
  }

  /** Clears a latched fall — the wearer pressing the button to say "I'm fine". */
  void acknowledge() {
    latchedUntilMs_ = 0;
    stage_ = Stage::kIdle;
  }

  bool isFallLatched(uint32_t nowMs) const {
    return latchedUntilMs_ != 0 && nowMs < latchedUntilMs_;
  }

  uint32_t fallCount() const { return falls_; }

 private:
  enum class Stage : uint8_t { kIdle, kFreeFall, kImpact };

  MotionThresholds t_;
  Stage stage_ = Stage::kIdle;
  uint32_t stageEnteredMs_ = 0;
  uint32_t latchedUntilMs_ = 0;
  uint32_t falls_ = 0;
};

// ---------------------------------------------------------------------------
// Sensor health
//
// Reported to the server so the hardware dashboard can say *which* sensor is
// unhappy. "Device online, no readings" sends an engineer to check a whole
// band; "MAX30102 not responding on I²C" sends them to one solder joint.
// ---------------------------------------------------------------------------
enum class SensorState : uint8_t {
  kAbsent = 0,   // Did not answer at boot — not fitted, or not wired.
  kOk,
  kNoContact,    // Present and answering, but not against skin.
  kFaulty,       // Answering with values that cannot be true.
};

inline const char* sensorStateName(SensorState s) {
  switch (s) {
    case SensorState::kOk:        return "ok";
    case SensorState::kNoContact: return "no_contact";
    case SensorState::kFaulty:    return "faulty";
    default:                      return "absent";
  }
}

/**
 * Whether a channel is worth transmitting.
 *
 * The band sends what it believes or it sends nothing. Both of these are
 * "nothing": a sensor that is not fitted, and one whose last several samples
 * were all rejected.
 */
inline bool channelIsTrustworthy(SensorState state, uint16_t rejectedRun,
                                 uint16_t maxRejectedRun = 5) {
  if (state != SensorState::kOk) return false;
  return rejectedRun < maxRejectedRun;
}

// ---------------------------------------------------------------------------
// Battery
//
// A LiPo's voltage is not linear in charge, and the naive (v - 3.0) / 1.2
// mapping reports 50% for most of the discharge and then falls off a cliff.
// A piecewise curve is closer, and the number matters here: it is what a
// clinician sees before deciding whether a quiet band is a flat one.
// ---------------------------------------------------------------------------
inline float batteryPercent(float volts) {
  struct Point { float v; float pct; };
  // Measured points for a single-cell LiPo under light load.
  static constexpr Point kCurve[] = {
    {3.30f,   0.0f}, {3.60f,  10.0f}, {3.70f,  25.0f}, {3.75f,  40.0f},
    {3.85f,  60.0f}, {3.95f,  75.0f}, {4.05f,  90.0f}, {4.20f, 100.0f},
  };
  constexpr size_t kPoints = sizeof(kCurve) / sizeof(kCurve[0]);

  if (volts <= kCurve[0].v) return 0.0f;
  if (volts >= kCurve[kPoints - 1].v) return 100.0f;

  for (size_t i = 1; i < kPoints; i++) {
    if (volts <= kCurve[i].v) {
      const float span = kCurve[i].v - kCurve[i - 1].v;
      const float into = volts - kCurve[i - 1].v;
      const float pctSpan = kCurve[i].pct - kCurve[i - 1].pct;
      return kCurve[i - 1].pct + (into / span) * pctSpan;
    }
  }
  return 100.0f;
}

}  // namespace averis
