#pragma once
#include <stdint.h>

// Command indices, NOT measured shaft degrees. Matches the user's tested formula:
// 0 -> 1000 us, 180 -> 2000 us, 360 -> 3000 us.
constexpr uint32_t sweepPulse(int index) {
  return 1000U + ((uint32_t)index * 1000U + 90U) / 180U;
}

class TimedSweep {
 public:
  static constexpr int step = 5;
  static constexpr uint32_t stepMs = 5;
  int position = 0;
  bool running = false, returning = false;

  constexpr void start(int a, int b, uint32_t hold, uint32_t duration, uint32_t now) {
    home = position = a; other = target = b; holdMs = hold; durationMs = duration;
    started = stepped = reached = now; holding = false; returning = false; running = true;
  }

  constexpr void tick(uint32_t now) {
    if (!running) return;
    // The runtime is a hard deadline for oscillation, including endpoint holds.
    if (!returning && (uint32_t)(now - started) >= durationMs) {
      returning = true; holding = false; target = home; stepped = now;
      if (position == home) { running = false; return; }
    }
    if (holding) {
      if ((uint32_t)(now - reached) < holdMs) return;
      holding = false; target = position == home ? other : home; stepped = now;
    }
    uint32_t ticks = (uint32_t)(now - stepped) / stepMs;
    if (!ticks) return;
    stepped += ticks * stepMs;
    int gap = target > position ? target - position : position - target;
    // Clamp before multiplying: handles late ticks and endpoints not divisible by 5.
    int advance = ticks >= (uint32_t)((gap + step - 1) / step) ? gap : (int)ticks * step;
    position += target > position ? advance : -advance;
    if (position == target) {
      if (returning) running = false;
      else { holding = true; reached = now; }
    }
  }

 private:
  int home = 0, other = 360, target = 360;
  bool holding = false;
  uint32_t holdMs = 500, durationMs = 1000, started = 0, stepped = 0, reached = 0;
};
