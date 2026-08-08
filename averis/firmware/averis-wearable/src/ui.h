#pragma once
/**
 * What the wearer sees and hears.
 *
 * ── The display's one rule ─────────────────────────────────────────────────
 *
 * **A number on this screen was measured.** When a channel has nothing
 * trustworthy, the screen shows "--", never the last good value and never a
 * plausible placeholder. A wearer glancing at a band that reads 97% while the
 * sensor has been off their wrist for ten minutes has been actively misled,
 * and this is the display of a medical device rather than of a fitness toy.
 *
 * ── The buzzer's one rule ──────────────────────────────────────────────────
 *
 * It sounds for things a person should act on and nothing else. No
 * confirmation beeps, no boot chime, no "sync complete". Every unnecessary
 * sound spends the only channel the band has for saying something urgent, and
 * a wearer who has learned that the beeping means nothing will not react when
 * it means something.
 */

#include <Arduino.h>
#include "signal_core.h"
#include "alert_levels.h"

namespace averis {

struct ScreenState {
  float heartRate;
  float spo2;
  float temperature;
  Movement movement;
  float batteryPercent;
  LocalAlert alert;
  bool cloudConnected;
  bool verified;
  bool bleClient;
  uint16_t bufferedCount;
};

class Display {
 public:
  bool begin();
  /** Idempotent: safe to call every loop, redraws only when something moved. */
  void render(const ScreenState& state);
  void showBootMessage(const char* line1, const char* line2);
  bool present() const { return present_; }

 private:
  void drawVitals(const ScreenState& state);
  void drawAlert(const ScreenState& state);

  bool present_ = false;
  uint32_t lastRenderMs_ = 0;
  LocalAlert lastAlert_ = LocalAlert::kNone;
};

class Buzzer {
 public:
  void begin();

  /**
   * Non-blocking. Call every loop.
   *
   * A blocking beep pattern would stop the IMU being sampled for the two
   * seconds it takes to sound a fall alert — which means the band stops
   * watching for the second fall while announcing the first.
   */
  void update(uint32_t nowMs, LocalAlert alert);
  void silence();

 private:
  LocalAlert active_ = LocalAlert::kNone;
  BuzzPattern pattern_ = {};
  uint16_t remainingBeeps_ = 0;
  bool toneOn_ = false;
  uint32_t phaseStartedMs_ = 0;
  uint32_t patternStartedMs_ = 0;
};

}  // namespace averis
