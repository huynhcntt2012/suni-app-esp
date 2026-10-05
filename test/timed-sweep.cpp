// Compile-time behavioral tests; same header used by ESP32 firmware.
#include "../firmware/PetFeeder/TimedSweep.h"
constexpr bool fullSweep() {
  TimedSweep s; s.start(0,360,500,2000,0);
  for(uint32_t t=0;t<=360;t+=5)s.tick(t);
  if(s.position!=360)return false;
  s.tick(855);if(s.position!=360)return false;
  s.tick(860);s.tick(865);if(s.position!=355)return false;
  for(uint32_t t=870;t<=2000;t+=5)s.tick(t);
  if(!s.returning)return false;
  for(uint32_t t=2005;t<=2360;t+=5)s.tick(t);
  return !s.running && s.position==0;
}
constexpr bool deadlineInHold() {
  TimedSweep s;s.start(0,360,500,500,0);
  for(uint32_t t=0;t<=500;t+=5)s.tick(t);
  if(!s.returning||s.position!=360)return false;
  for(uint32_t t=505;t<=860;t+=5)s.tick(t);
  return !s.running&&s.position==0;
}
constexpr bool reverseAndClamp() {
  TimedSweep s;s.start(103,17,20,200,0);
  for(uint32_t t=0;t<=290;t+=5){s.tick(t);if(s.position<17||s.position>103)return false;}
  return !s.running&&s.position==103;
}
constexpr bool rollover() {
  TimedSweep s;uint32_t start=0xFFFFFF00U;s.start(0,360,500,1000,start);
  for(uint32_t offset=0;offset<=1360;offset+=5)s.tick(start+offset);
  return !s.running&&s.position==0;
}
constexpr bool noReplayAfterDone() {
  TimedSweep s;s.start(0,360,500,200,0);
  for(uint32_t t=0;t<=1000;t+=5)s.tick(t);
  s.tick(50000);return !s.running&&s.position==0;
}
static_assert(sweepPulse(0)==1000 && sweepPulse(180)==2000 && sweepPulse(360)==3000,"Tested pulse mapping");
static_assert(fullSweep(),"Sweep, hold, deadline and return");
static_assert(deadlineInHold(),"Deadline interrupts endpoint hold");
static_assert(reverseAndClamp(),"Reverse endpoints and non-multiple step clamp");
static_assert(rollover(),"millis rollover");
static_assert(noReplayAfterDone(),"An API command cannot become an infinite sweep");
