#include "sensors.h"
#include "config.h"

#include <MAX30105.h>
#include <spo2_algorithm.h>
#include <heartRate.h>
#include <Adafruit_MLX90614.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

namespace averis {

namespace {
MAX30105 gPulse;
Adafruit_MLX90614 gThermo;
Adafruit_MPU6050 gImu;

/**
 * Below this IR count there is nothing in front of the sensor.
 *
 * The single most important constant in this file. Without it the MAX30102
 * happily reports a heart rate derived from ambient light flicker — a
 * plausible 60-something BPM, for a band sitting on a desk. That number is
 * indistinguishable downstream from a real one, and it is how a monitoring
 * platform ends up with a full chart for a patient who was not wearing
 * anything.
 */
constexpr long kContactIrThreshold = 50000;

/** How long contact must be lost before the filters are thrown away. */
constexpr uint32_t kContactGraceMs = 1500;
}  // namespace

// ------------------------------------------------------------------ pulse
bool PulseSensor::begin() {
  present_ = gPulse.begin(Wire, I2C_SPEED_FAST);
  if (!present_) return false;

  // 0x1F on the red LED, 0x1F on IR: enough signal through skin without
  // cooking the LED budget on a coin cell.
  gPulse.setup(0x1F, 4, 2, 100, 411, 4096);
  gPulse.setPulseAmplitudeRed(0x0A);
  gPulse.setPulseAmplitudeGreen(0);
  return true;
}

void PulseSensor::sample(uint32_t nowMs) {
  if (!present_) return;

  const long ir = gPulse.getIR();
  const long red = gPulse.getRed();

  if (ir < kContactIrThreshold) {
    // Not on skin. Grace period first, because a wrist rolling on a pillow
    // dips below threshold for a few hundred milliseconds and throwing the
    // window away every time would mean never reporting anything overnight.
    if (lastContactMs_ != 0 && nowMs - lastContactMs_ > kContactGraceMs) {
      contact_ = false;
      hr_.reset();
      spo2_.reset();
    }
    return;
  }

  contact_ = true;
  lastContactMs_ = nowMs;

  if (checkForBeat(ir)) {
    static uint32_t lastBeatMs = 0;
    if (lastBeatMs != 0) {
      const uint32_t delta = nowMs - lastBeatMs;
      if (delta > 0) hr_.push(60000.0f / static_cast<float>(delta));
    }
    lastBeatMs = nowMs;
  }

  // Ratio of ratios, the datasheet's generic curve. Not calibrated against a
  // reference oximeter on this unit — see the note in sensors.h and the
  // accuracy section of docs/HARDWARE.md.
  if (red > 0 && ir > 0) {
    const float ratio = (static_cast<float>(red) / static_cast<float>(ir));
    const float estimate = 110.0f - 25.0f * ratio;
    if (kSpo2.contains(estimate)) spo2_.push(estimate);
  }
}

SensorState PulseSensor::state() const {
  if (!present_) return SensorState::kAbsent;
  if (!contact_) return SensorState::kNoContact;
  // A long run of rejections while contact is held means the part is answering
  // with values that cannot be true, which is a different fault from a wrist
  // that moved.
  return hr_.rejectedRun() > 20 ? SensorState::kFaulty : SensorState::kOk;
}

// ------------------------------------------------------------ thermometer
bool Thermometer::begin() {
  present_ = gThermo.begin();
  return present_;
}

void Thermometer::sample(uint32_t) {
  if (!present_) return;

  const float object = gThermo.readObjectTempC();
  ambient_ = gThermo.readAmbientTempC();

  // The library returns NaN on a bus error. Pushing it would poison the
  // window, and the plausibility range would reject it anyway — but counting
  // it as a rejection is what makes a failing sensor visible as `faulty`
  // rather than as silence.
  temp_.push(object);
}

SensorState Thermometer::state() const {
  if (!present_) return SensorState::kAbsent;
  return temp_.rejectedRun() > 10 ? SensorState::kFaulty : SensorState::kOk;
}

// ------------------------------------------------------------------- imu
bool MotionSensor::begin() {
  present_ = gImu.begin();
  if (!present_) return false;

  // ±8g: a human fall impact reaches 4–6g, and the ±2g default clips it flat —
  // which reads as a gentler event than it was, in exactly the case that
  // matters.
  gImu.setAccelerometerRange(MPU6050_RANGE_8_G);
  gImu.setGyroRange(MPU6050_RANGE_500_DEG);
  gImu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  return true;
}

void MotionSensor::sample(uint32_t nowMs) {
  if (!present_) {
    movement_ = Movement::kUnknown;
    return;
  }

  sensors_event_t accel, gyro, temp;
  gImu.getEvent(&accel, &gyro, &temp);

  // m/s² → g.
  const float x = accel.acceleration.x / 9.80665f;
  const float y = accel.acceleration.y / 9.80665f;
  const float z = accel.acceleration.z / 9.80665f;
  magnitude_ = sqrtf(x * x + y * y + z * z);

  movement_ = fall_.update(magnitude_, nowMs);
}

// --------------------------------------------------------------- battery
void BatteryMonitor::begin() {
  analogReadResolution(12);
  // 11 dB of attenuation puts the usable ADC range at roughly 0–3.3V, which is
  // where a 2:1 divider from a 4.2V cell lands.
  analogSetPinAttenuation(AVERIS_BATTERY_ADC_PIN, ADC_11db);
}

void BatteryMonitor::sample() {
  const int raw = analogRead(AVERIS_BATTERY_ADC_PIN);
  const float measured = (static_cast<float>(raw) / 4095.0f) * 3.3f;
  filtered_.push(measured * AVERIS_BATTERY_DIVIDER);
  volts_ = filtered_.value();
}

}  // namespace averis
