#pragma once
/**
 * BLE — the AVERIS Health Service.
 *
 * A second way to reach the band, for the case WiFi cannot serve: a phone
 * beside the wearer when there is no network at all, and an engineer standing
 * next to a band that will not join a network, who needs to see whether the
 * sensors are alive before deciding whether the fault is the band or the WiFi.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not a second ingest path. Nothing read over BLE reaches a patient's
 * chart, and there is no BLE writer anywhere in AVERIS. The reason is
 * authentication: the HTTP path proves the band's identity with a token the
 * server hashed at registration, and a GATT characteristic has no equivalent —
 * pairing proves proximity, not identity. A "relay to cloud" app built on this
 * would be an unauthenticated write path into a medical record wearing the
 * costume of a phone app.
 *
 * So this is a **read-only local view**, and the phase's brief says
 * "foundation" — this is the honest version of that word.
 *
 * ── What is exposed ────────────────────────────────────────────────────────
 *
 * Standard SIG UUIDs where one exists, because a nurse's phone with a generic
 * BLE tool should be able to read a heart rate without knowing what AVERIS is:
 *
 *   Heart Rate Service      0x180D  ← standard
 *     Heart Rate Measurement 0x2A37 ← standard, flags byte + uint8 BPM
 *   Health Thermometer      0x1809  ← standard
 *     Temperature Measurement 0x2A1C
 *   Battery Service         0x180F  ← standard
 *
 * And a vendor service for the parts with no standard equivalent — SpO2,
 * movement, sensor health — rather than smuggling them into a standard
 * characteristic with a private format, which is how a generic tool ends up
 * displaying a movement code as a temperature.
 *
 * No characteristic here carries a name, a patient id or anything else
 * identifying: a BLE advertisement is world-readable, and a band advertising
 * "Ananya Verma" tells a room who is wearing a medical device.
 */

#include <Arduino.h>
#include "signal_core.h"

namespace averis {

/** Vendor service. Random UUID, fixed for the product line. */
#define AVERIS_BLE_SERVICE_UUID        "b7e4a3c0-9f21-4f6b-9c2d-1a5e7f3d8c40"
#define AVERIS_BLE_CHAR_SPO2_UUID      "b7e4a3c1-9f21-4f6b-9c2d-1a5e7f3d8c40"
#define AVERIS_BLE_CHAR_MOVEMENT_UUID  "b7e4a3c2-9f21-4f6b-9c2d-1a5e7f3d8c40"
#define AVERIS_BLE_CHAR_STATUS_UUID    "b7e4a3c3-9f21-4f6b-9c2d-1a5e7f3d8c40"

struct BleSnapshot {
  float heartRate;
  float spo2;
  float temperature;
  Movement movement;
  float batteryPercent;
  SensorState pulseSensor;
  SensorState thermometer;
  SensorState imu;
  bool cloudConnected;
  bool verified;
  uint16_t bufferedCount;
};

class BleService {
 public:
  /** Advertises as "AVERIS-<device key>" — a device id, never a person. */
  void begin(const char* deviceKey);
  void publish(const BleSnapshot& snapshot);
  bool clientConnected() const;

 private:
  bool started_ = false;
};

}  // namespace averis
