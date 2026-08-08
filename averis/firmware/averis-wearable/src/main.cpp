/**
 * AVERIS wearable — ESP32 firmware.
 *
 *     boot → self-test → WiFi → hello → [ sample · evaluate · display · uplink ]
 *
 * The band replaces `sensor_simulator/simulate.py` and nothing else in AVERIS
 * changes. That was the point of building the simulator as an HTTP client in
 * Phase 1 rather than as seeded rows: the wire contract, the ingest service,
 * the alert rules, the AI engine and every dashboard were written against the
 * same bytes this file now sends.
 *
 * ── The loop is not the uplink ─────────────────────────────────────────────
 *
 * Sensors are sampled at 20 Hz (IMU) and 4 Hz (vitals); readings go out every
 * two seconds. Sampling at the uplink rate would be simpler and would miss
 * falls entirely — the impact phase lasts under 100 ms and would land between
 * samples. What is transmitted is the *filtered* value from many samples,
 * which is also why one bad sensor frame does not become a reading in
 * somebody's chart.
 *
 * ── Local alerting has no dependency on the network ────────────────────────
 *
 * The buzzer and the screen are driven from values computed on this device.
 * A band in a lift, a basement, or on a revoked token still tells the person
 * wearing it that their oxygen is low. Everything the *care team* sees comes
 * from the server, which is the only place that decides anything clinical.
 */

#include <Arduino.h>
#include <Wire.h>

#include "config.h"
#include "signal_core.h"
#include "alert_levels.h"
#include "payload.h"
#include "sensors.h"
#include "net.h"
#include "ble.h"
#include "ui.h"

using namespace averis;

namespace {

PulseSensor gPulse;
Thermometer gThermo;
MotionSensor gMotion;
BatteryMonitor gBattery;
Uplinker gUplink;
BleService gBle;
Display gDisplay;
Buzzer gBuzzer;

/** Survives deep sleep; ordinary globals do not. */
RTC_DATA_ATTR uint32_t gBootCount = 0;
RTC_DATA_ATTR uint32_t gLastEpochSeconds = 0;

uint32_t gUplinkIntervalMs = AVERIS_UPLINK_INTERVAL_MS;
uint32_t gLastUplinkMs = 0;
uint32_t gLastImuMs = 0;
uint32_t gLastVitalsMs = 0;
uint32_t gLastBatteryMs = 0;
uint32_t gEpochAtBootSeconds = 0;
uint32_t gBootMillis = 0;
bool gVerified = false;

/** Seconds since the epoch, from the server's clock plus elapsed millis. */
uint32_t nowEpochSeconds() {
  if (gEpochAtBootSeconds == 0) return 0;
  return gEpochAtBootSeconds + (millis() - gBootMillis) / 1000;
}

/**
 * Boot self-test.
 *
 * Every sensor is probed and the result is *reported*, never fatal. A band
 * that refused to run without a thermometer would stop watching a heart
 * because a temperature sensor came loose, and the dashboard already knows how
 * to render a missing channel.
 */
void selfTest() {
  const bool pulse = gPulse.begin();
  const bool thermo = gThermo.begin();
  const bool imu = gMotion.begin();
  gBattery.begin();

#if AVERIS_SERIAL_DEBUG
  Serial.printf("self-test  pulse=%s thermometer=%s imu=%s\n",
                pulse ? "ok" : "ABSENT", thermo ? "ok" : "ABSENT", imu ? "ok" : "ABSENT");
#endif

  char line[32];
  snprintf(line, sizeof(line), "HR%s T%s M%s", pulse ? "+" : "-", thermo ? "+" : "-",
           imu ? "+" : "-");
  gDisplay.showBootMessage("Self-test", line);

  if (!pulse && !thermo && !imu) {
    // Nothing answered on I²C. One wire, almost always — and a band that says
    // so is a band an engineer fixes in a minute instead of reflashing.
    gDisplay.showBootMessage("No sensors", "Check I2C wiring");
  }
}

/** The wearer's "I'm fine" button: clears a latched fall and the buzzer. */
void handleButton() {
  static uint32_t lastPressMs = 0;
  if (digitalRead(AVERIS_BUTTON_PIN) != LOW) return;

  const uint32_t nowMs = millis();
  if (nowMs - lastPressMs < 400) return;  // debounce
  lastPressMs = nowMs;

  // Clears the local alert only. The emergency event on the server stays open
  // until a clinician resolves it — a wearer silencing their own band is not
  // the same claim as a person having been checked on, and collapsing the two
  // is how a fall gets closed by the person who fell.
  gMotion.acknowledgeFall();
  gBuzzer.silence();
}

}  // namespace

void setup() {
  gBootCount++;
  gBootMillis = millis();

#if AVERIS_SERIAL_DEBUG
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nAVERIS wearable %s  boot #%lu\n", AVERIS_FIRMWARE_VERSION,
                static_cast<unsigned long>(gBootCount));
#endif

  pinMode(AVERIS_BUTTON_PIN, INPUT_PULLUP);
  Wire.begin(AVERIS_I2C_SDA, AVERIS_I2C_SCL);
  Wire.setClock(400000);

  gDisplay.begin();
  gBuzzer.begin();
  gDisplay.showBootMessage("Starting", AVERIS_DEVICE_KEY);

  selfTest();

  gBle.begin(AVERIS_DEVICE_KEY);

  gDisplay.showBootMessage("WiFi", AVERIS_WIFI_SSID);
  if (gUplink.connectWifi()) {
    const HelloResponse hello = gUplink.hello();
    gVerified = hello.verified;

    if (hello.ok) {
      // The server's clock is the only one the band trusts. An ESP32 has no
      // RTC across a power cycle, and a reading stamped 1970 sorts before
      // every reading the patient has ever produced.
      if (hello.epochSeconds > 0) {
        gEpochAtBootSeconds = hello.epochSeconds;
        gLastEpochSeconds = hello.epochSeconds;
      }
      // Cadence from the server, so a fleet can be re-paced without a reflash.
      if (hello.uplinkIntervalMs >= 500) gUplinkIntervalMs = hello.uplinkIntervalMs;

      gDisplay.showBootMessage(hello.verified ? "Verified" : "Not verified",
                               hello.deviceName[0] ? hello.deviceName : AVERIS_DEVICE_KEY);
    } else {
      gDisplay.showBootMessage("Server", "No response");
    }
  } else {
    // Not fatal. The band monitors and buzzes locally, and buffers what it
    // cannot send.
    gDisplay.showBootMessage("No WiFi", "Local alerts only");
  }

  delay(1200);
}

void loop() {
  const uint32_t nowMs = millis();

  handleButton();

  // ── Sampling ─────────────────────────────────────────────────────────────
  if (nowMs - gLastImuMs >= 1000 / AVERIS_IMU_SAMPLE_HZ) {
    gLastImuMs = nowMs;
    gMotion.sample(nowMs);
  }

  if (nowMs - gLastVitalsMs >= 1000 / AVERIS_VITALS_SAMPLE_HZ) {
    gLastVitalsMs = nowMs;
    gPulse.sample(nowMs);
    gThermo.sample(nowMs);
  }

  if (nowMs - gLastBatteryMs >= 5000) {
    gLastBatteryMs = nowMs;
    gBattery.sample();
  }

  // ── Local evaluation ─────────────────────────────────────────────────────
  // Computed here, from this device's own filtered values. Nothing below waits
  // on the network.
  const float heartRate = gPulse.heartRate();
  const float spo2 = gPulse.spo2();
  const float temperature = gThermo.temperature();
  const float battery = gBattery.percent();
  const bool fallLatched = gMotion.fallLatched(nowMs);

  const LocalAlert alert =
      evaluateLocalAlert(heartRate, spo2, temperature, battery, fallLatched);

  gBuzzer.update(nowMs, alert);

  ScreenState screen{};
  screen.heartRate = heartRate;
  screen.spo2 = spo2;
  screen.temperature = temperature;
  screen.movement = gMotion.movement();
  screen.batteryPercent = battery;
  screen.alert = alert;
  screen.cloudConnected = gUplink.wifiConnected() && !gUplink.isLockedOut();
  screen.verified = gVerified;
  screen.bleClient = gBle.clientConnected();
  screen.bufferedCount = gUplink.bufferedCount();
  gDisplay.render(screen);

  // ── Uplink ───────────────────────────────────────────────────────────────
  if (nowMs - gLastUplinkMs >= gUplinkIntervalMs) {
    gLastUplinkMs = nowMs;

    char iso[24];
    const bool haveClock = formatIso8601(nowEpochSeconds(), iso, sizeof(iso));

    Uplink reading{};
    reading.deviceKey = AVERIS_DEVICE_KEY;
    reading.heartRate = heartRate;
    reading.spo2 = spo2;
    reading.temperature = temperature;
    reading.movement = gMotion.movement();
    reading.batteryPercent = battery;
    reading.recordedAt = haveClock ? iso : "";
    reading.rssiDbm = gUplink.rssi();
    reading.uptimeSeconds = nowMs / 1000;
    reading.bootCount = gBootCount;
    reading.firmwareVersion = AVERIS_FIRMWARE_VERSION;
    reading.transport = "wifi";
    reading.pulseSensor = gPulse.state();
    reading.thermometer = gThermo.state();
    reading.imu = gMotion.state();
    reading.bufferedCount = gUplink.bufferedCount();

    // A reading with nothing measurable in it is not sent. The server would
    // reject it anyway ("a reading must carry at least one measurement"), and
    // spending the radio to be told so costs battery the band needs for the
    // moment a sensor comes back.
    const bool worthSending = hasValue(heartRate) || hasValue(spo2) || hasValue(temperature);

    if (worthSending) {
      // Below the low-power threshold the band stops transmitting and keeps
      // only local alerting, so the last of the battery is spent buzzing at
      // the wearer rather than talking to a server.
      const bool radioAllowed =
          !hasValue(battery) || battery > AVERIS_LOW_POWER_BATTERY_PCT;

      if (!radioAllowed) {
        gUplink.buffer(reading, haveClock ? iso : "");
      } else {
        const UplinkResult result = gUplink.send(reading);

        if (result == UplinkResult::kRetryLater) {
          // Kept with its own timestamp, so it lands where it was measured
          // rather than where it was delivered.
          gUplink.buffer(reading, haveClock ? iso : "");
        }

#if AVERIS_SERIAL_DEBUG
        Serial.printf("uplink %s  hr=%.0f spo2=%.0f t=%.1f %s buffered=%u\n",
                      result == UplinkResult::kAccepted ? "ok" : "deferred",
                      static_cast<double>(hasValue(heartRate) ? heartRate : 0),
                      static_cast<double>(hasValue(spo2) ? spo2 : 0),
                      static_cast<double>(hasValue(temperature) ? temperature : 0),
                      movementName(gMotion.movement()),
                      static_cast<unsigned>(gUplink.bufferedCount()));
#endif
      }
    }

    BleSnapshot snapshot{};
    snapshot.heartRate = heartRate;
    snapshot.spo2 = spo2;
    snapshot.temperature = temperature;
    snapshot.movement = gMotion.movement();
    snapshot.batteryPercent = battery;
    snapshot.pulseSensor = gPulse.state();
    snapshot.thermometer = gThermo.state();
    snapshot.imu = gMotion.state();
    snapshot.cloudConnected = gUplink.wifiConnected();
    snapshot.verified = gVerified;
    snapshot.bufferedCount = gUplink.bufferedCount();
    gBle.publish(snapshot);

#if AVERIS_DEEP_SLEEP_ENABLED
    // Deep sleep is off by default and this is why: a sleeping band is not
    // monitoring anyone. It is defensible for an activity tracker and wrong
    // for someone at risk of falling, so it is a deliberate per-deployment
    // choice rather than a default that quietly trades away the product.
    //
    // A fall is never slept through: the latch is checked first, and the
    // wake-on-motion interrupt is what brings the band back if one starts.
    if (!fallLatched && alert == LocalAlert::kNone) {
      gLastEpochSeconds = nowEpochSeconds();
      esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(AVERIS_DEEP_SLEEP_MS) * 1000ULL);
      esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(AVERIS_BUTTON_PIN), 0);
      esp_deep_sleep_start();
    }
#endif
  }

  // Yields to the WiFi and BLE stacks. Without it they starve and the watchdog
  // resets the band — which looks exactly like a hardware fault in the field.
  delay(5);
}
