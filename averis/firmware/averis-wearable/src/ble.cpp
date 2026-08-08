#include "ble.h"
#include "config.h"

#if AVERIS_ENABLE_BLE

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

namespace averis {

namespace {

BLEServer* gServer = nullptr;
BLECharacteristic* gHeartRate = nullptr;
BLECharacteristic* gTemperature = nullptr;
BLECharacteristic* gBattery = nullptr;
BLECharacteristic* gSpo2 = nullptr;
BLECharacteristic* gMovement = nullptr;
BLECharacteristic* gStatus = nullptr;

volatile bool gConnected = false;

class ConnectionWatcher : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { gConnected = true; }
  void onDisconnect(BLEServer* server) override {
    gConnected = false;
    // Without this the band stops advertising after the first client leaves,
    // and an engineer's second attempt to connect finds nothing there.
    server->startAdvertising();
  }
};

ConnectionWatcher gWatcher;

}  // namespace

void BleService::begin(const char* deviceKey) {
  if (started_) return;

  char name[32];
  // The device key, never the wearer. A BLE advertisement is world-readable,
  // and a band broadcasting a patient's name tells a waiting room who is
  // wearing a medical device.
  snprintf(name, sizeof(name), "AVERIS-%s", deviceKey);

  BLEDevice::init(name);
  gServer = BLEDevice::createServer();
  gServer->setCallbacks(&gWatcher);

  // ── Standard services, so a generic BLE tool can read vitals ────────────
  BLEService* heartRateService = gServer->createService(BLEUUID((uint16_t)0x180D));
  gHeartRate = heartRateService->createCharacteristic(
      BLEUUID((uint16_t)0x2A37),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gHeartRate->addDescriptor(new BLE2902());
  heartRateService->start();

  BLEService* thermometerService = gServer->createService(BLEUUID((uint16_t)0x1809));
  gTemperature = thermometerService->createCharacteristic(
      BLEUUID((uint16_t)0x2A1C),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gTemperature->addDescriptor(new BLE2902());
  thermometerService->start();

  BLEService* batteryService = gServer->createService(BLEUUID((uint16_t)0x180F));
  gBattery = batteryService->createCharacteristic(
      BLEUUID((uint16_t)0x2A19),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gBattery->addDescriptor(new BLE2902());
  batteryService->start();

  // ── Vendor service for what has no standard equivalent ──────────────────
  // SpO2 and movement go here rather than into a standard characteristic with
  // a private format, which is how a generic tool ends up rendering a movement
  // code as a temperature.
  BLEService* averisService = gServer->createService(AVERIS_BLE_SERVICE_UUID);

  gSpo2 = averisService->createCharacteristic(
      AVERIS_BLE_CHAR_SPO2_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gSpo2->addDescriptor(new BLE2902());

  gMovement = averisService->createCharacteristic(
      AVERIS_BLE_CHAR_MOVEMENT_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gMovement->addDescriptor(new BLE2902());

  // Everything an engineer needs to triage a band they are standing next to:
  // which sensors answered, whether it reached the cloud, whether the server
  // accepted its token, and how much it is holding.
  gStatus = averisService->createCharacteristic(
      AVERIS_BLE_CHAR_STATUS_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gStatus->addDescriptor(new BLE2902());

  averisService->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLEUUID((uint16_t)0x180D));
  advertising->addServiceUUID(AVERIS_BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  started_ = true;
}

void BleService::publish(const BleSnapshot& s) {
  if (!started_) return;

  // Heart Rate Measurement: flags byte then uint8 BPM. Flags 0x00 says
  // "8-bit value, no contact detection, no energy expended" — which is true,
  // and claiming contact detection we do not implement would make a phone
  // display a green heart on a band lying on a table.
  if (hasValue(s.heartRate)) {
    uint8_t frame[2] = {0x00, static_cast<uint8_t>(constrain(s.heartRate, 0.0f, 255.0f))};
    gHeartRate->setValue(frame, sizeof(frame));
    gHeartRate->notify();
  }

  // Temperature Measurement: flags then an IEEE-11073 32-bit float. The
  // exponent is -1 and the mantissa is tenths of a degree.
  if (hasValue(s.temperature)) {
    const int32_t mantissa = static_cast<int32_t>(lroundf(s.temperature * 10.0f));
    uint8_t frame[5];
    frame[0] = 0x00;  // Celsius
    frame[1] = mantissa & 0xFF;
    frame[2] = (mantissa >> 8) & 0xFF;
    frame[3] = (mantissa >> 16) & 0xFF;
    frame[4] = 0xFF;  // exponent -1, as a signed byte
    gTemperature->setValue(frame, sizeof(frame));
    gTemperature->notify();
  }

  if (hasValue(s.batteryPercent)) {
    uint8_t level = static_cast<uint8_t>(constrain(s.batteryPercent, 0.0f, 100.0f));
    gBattery->setValue(&level, 1);
    gBattery->notify();
  }

  // A channel with nothing trustworthy to say publishes "--", not a stale
  // number. The same rule as the uplink: the band says what it believes or it
  // says nothing.
  char text[24];
  if (hasValue(s.spo2)) {
    snprintf(text, sizeof(text), "%d", static_cast<int>(lroundf(s.spo2)));
  } else {
    snprintf(text, sizeof(text), "--");
  }
  gSpo2->setValue(text);
  gSpo2->notify();

  gMovement->setValue(movementName(s.movement));
  gMovement->notify();

  char status[96];
  snprintf(status, sizeof(status),
           "pulse=%s;temp=%s;imu=%s;cloud=%s;verified=%s;buffered=%u",
           sensorStateName(s.pulseSensor), sensorStateName(s.thermometer),
           sensorStateName(s.imu), s.cloudConnected ? "up" : "down",
           s.verified ? "yes" : "no", static_cast<unsigned>(s.bufferedCount));
  gStatus->setValue(status);
  gStatus->notify();
}

bool BleService::clientConnected() const { return gConnected; }

}  // namespace averis

#else  // AVERIS_ENABLE_BLE

namespace averis {
void BleService::begin(const char*) {}
void BleService::publish(const BleSnapshot&) {}
bool BleService::clientConnected() const { return false; }
}  // namespace averis

#endif
