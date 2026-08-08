#pragma once
/**
 * The three sensors, behind one interface.
 *
 * Each wrapper does the same two things: report whether the part answered at
 * boot, and produce a filtered value or nothing. Everything about *which*
 * chip it is stays in here — the loop in main.cpp asks for a heart rate, not
 * for a MAX30102.
 *
 * ── A sensor that is missing is not an error ───────────────────────────────
 *
 * `begin()` returning false is a normal outcome and the band carries on. A
 * chest strap has no thermometer; a pulse oximeter has no IMU; a prototype has
 * whatever was in the drawer. A band that refuses to boot without all three
 * would be a band that stops monitoring a heart because a thermometer came
 * loose, which is the wrong trade in every direction.
 *
 * What it must not do is claim a reading it does not have. Absent sensors
 * report `SensorState::kAbsent` and contribute no field to the uplink, so the
 * dashboard says "not fitted" rather than drawing a flat line at zero.
 */

#include <Arduino.h>
#include <Wire.h>
#include "signal_core.h"

namespace averis {

/**
 * MAX30102 — heart rate and SpO2.
 *
 * The library gives raw IR/red counts and a beat detector. Turning those into
 * a defensible SpO2 number is genuinely hard, and this firmware does not
 * pretend otherwise: the ratio-of-ratios calibration below is the datasheet's
 * generic curve, not a per-unit calibration against a reference oximeter.
 *
 * That limitation is recorded in docs/HARDWARE.md and surfaced in the UI, for
 * the same reason the risk models carry their cohort: a number whose accuracy
 * nobody has established should not be presented as though someone has.
 */
class PulseSensor {
 public:
  bool begin();
  /** Samples the sensor. Call at AVERIS_VITALS_SAMPLE_HZ. */
  void sample(uint32_t nowMs);

  float heartRate() const { return trustworthy() ? hr_.value() : kNoValue; }
  float spo2() const { return trustworthy() ? spo2_.value() : kNoValue; }
  SensorState state() const;

  /** Whether a finger/wrist is actually against the sensor. */
  bool hasContact() const { return contact_; }

 private:
  bool trustworthy() const {
    return present_ && contact_ && channelIsTrustworthy(state(), hr_.rejectedRun());
  }

  bool present_ = false;
  bool contact_ = false;
  // Windows of 12 at 4 Hz: three seconds of signal. Long enough to reject a
  // shifting finger, short enough that a real change is not delayed past the
  // two-second uplink.
  SmoothedChannel<12> hr_{kHeartRate, 25.0f};
  SmoothedChannel<12> spo2_{kSpo2, 6.0f};
  uint32_t lastContactMs_ = 0;
};

/**
 * MLX90614 — non-contact infrared thermometer.
 *
 * Reports skin temperature, which is not core temperature. The offset between
 * them varies with ambient temperature, perfusion and where the sensor sits,
 * and a fixed +2°C fudge would produce a number that looks like a fever
 * reading and is not one.
 *
 * So the raw object temperature is sent, the field is labelled as skin
 * temperature end to end, and no correction is invented here. The alert
 * thresholds upstream were chosen for body temperature — that mismatch is
 * documented rather than papered over with a constant.
 */
class Thermometer {
 public:
  bool begin();
  void sample(uint32_t nowMs);

  float temperature() const {
    return present_ && channelIsTrustworthy(state(), temp_.rejectedRun())
               ? temp_.value()
               : kNoValue;
  }
  float ambient() const { return ambient_; }
  SensorState state() const;

 private:
  bool present_ = false;
  SmoothedChannel<8> temp_{kTemperature, 1.5f};
  float ambient_ = kNoValue;
};

/**
 * MPU6050 — motion, activity and falls.
 *
 * Sampled at 20 Hz because the impact phase of a real fall lasts well under
 * 100ms. At the 0.5 Hz uplink rate the impact simply falls between samples,
 * and the band would report a person on the floor as "resting".
 */
class MotionSensor {
 public:
  bool begin();
  void sample(uint32_t nowMs);

  Movement movement() const { return movement_; }
  bool fallLatched(uint32_t nowMs) const { return fall_.isFallLatched(nowMs); }
  void acknowledgeFall() { fall_.acknowledge(); }
  uint32_t fallCount() const { return fall_.fallCount(); }
  float lastMagnitudeG() const { return magnitude_; }
  SensorState state() const { return present_ ? SensorState::kOk : SensorState::kAbsent; }

 private:
  bool present_ = false;
  FallDetector fall_;
  Movement movement_ = Movement::kUnknown;
  float magnitude_ = 1.0f;
};

/** Battery voltage from the divider on AVERIS_BATTERY_ADC_PIN. */
class BatteryMonitor {
 public:
  void begin();
  void sample();
  float volts() const { return volts_; }
  float percent() const { return hasValue(volts_) ? batteryPercent(volts_) : kNoValue; }

 private:
  float volts_ = kNoValue;
  // Heavily smoothed: the ADC on an ESP32 is noisy, and a battery percentage
  // that jitters by 8% between screens looks broken even when the cell is fine.
  SmoothedChannel<16> filtered_{{2.5f, 4.4f}, 0.35f};
};

}  // namespace averis
