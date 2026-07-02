# Hardware Hookup Guide

Station: **FLEX-8400 → ACOM 700S → ACOM 06AT → antennas**, bridge PC (or Pi/Mac) on the shack LAN.
Same topology applies to other S-series amps and the 04AT.

## The complete picture

```
                                  LAN (Ethernet)
        ┌──────────────────────────────────────────────────┐
        │                                                  │
  ┌─────┴─────┐                                     ┌──────┴──────┐
  │ FLEX-8400 │                                     │  bridge PC  │
  │           │                                     │  (bridge +  │
  │ ANT1 ○────┼── coax #1 ──────────────┐           │  dashboard) │
  │ TX1  ○────┼── RCA PTT ────────┐     │           └──┬───────┬──┘
  └───────────┘                   │     │        USB-RS232      USB-RS232
                                  │     │        (FTDI #1)      (FTDI #2)
                              ┌───▼─────▼───┐        │              │
                              │  ACOM 700S  │◄───────┘              │
                              │             │  CAT/AUX              │
                              │  KEY-IN  RF │◄────────────——————────┘
                              │          IN │   RS-232 remote (pins 2/3/5)
                              │             │
                              │  RF OUTPUT ○┼── coax #2 (RF + 26 VDC + control!)
                              └─────────────┘         │
                                              ┌───────▼───────┐
                                              │   ACOM 06AT   │
                                              │  ANT1..ANT4 ○─┼── antennas
                                              └───────────────┘
```

Five connections total, plus antennas. **There is no serial cable between the amp and the radio** — the bridge replaces it. There is also **no power or control cable to the 06AT**: the tuner receives its 26 VDC supply *and* its control channel (a 60 kHz FSK modem) over the RF coax from the amp.

## Cables you need

| # | Cable | From | To | Notes |
|---|---|---|---|---|
| 1 | 50 Ω coax jumper | FLEX-8400 **ANT1** | 700S **RF INPUT** | Short, good-quality jumper |
| 2 | 50 Ω coax | 700S **RF OUTPUT** | 06AT **INPUT** | **Nothing in-line.** No wattmeter, antenna switch, lightning arrestor, or DC-blocked device in this segment — it carries DC power and the control modem as well as RF. Up to 100 m, indoor run |
| 3 | RCA–RCA | FLEX-8400 **TX1** | 700S **KEY-IN** | PTT keying line |
| 4 | USB–RS232 (FTDI) #1 | PC USB | 700S **CAT/AUX** | Wired per the CAT pinout in the 700S manual for Kenwood: TXD, RXD, GND. This is the same cable that would have gone to the radio — it goes to the PC instead |
| 5 | USB–RS232 (FTDI) #2 | PC USB | 700S **RS-232** (rear DB9) | **Pins 2, 3, 5 only** (straight-through TxD/RxD/GND). Leave pins 4/6/7/8 unconnected — the amp uses the handshake lines for remote power on/off, and a fully-wired cable can block the front-panel power button or power-cycle the amp |
| — | Antennas | 06AT **ANT1–ANT4** | your antennas | Assign per band in the amp's ATU menu |

Use FTDI-chip USB-serial adapters — ACOM specifically recommends FTDI, and clone Prolific chips are a reliability lottery.

## Hookup sequence

Do this in order, with **everything powered off and mains disconnected from the amp**:

1. **Ground first.** Bond radio, amp, tuner, and PC chassis to the station ground bus before any signal cables.
2. **Remove the old CAT cable** between the amp and the Flex, if one exists. The amp's CAT port must see only the bridge from now on.
3. **Coax #2: amp RF OUTPUT → 06AT INPUT.** Do this before anything else RF, and inspect the connectors — this run carries 26 VDC on the center conductor. A shorted or corroded connector here takes out the tuner supply.
4. **Antennas → 06AT ANT1–ANT4.** Note which antenna is on which port; you'll assign them to bands in the amp menu.
5. **Coax #1: Flex ANT1 → amp RF INPUT.**
6. **RCA PTT: Flex TX1 → amp KEY-IN.**
7. **FTDI #1: PC → amp CAT/AUX.**
8. **FTDI #2: PC → amp RS-232 remote** (pins 2/3/5 cable).
9. **Ethernet:** radio and PC on the same LAN (they just need IP reachability — same subnet is simplest).

## First power-up sequence

1. **Radio first.** Power the FLEX-8400, start SmartSDR or AetherSDR.
2. **Radio-side settings** (one time):
   - SmartSDR → Settings → **TX Band Settings**: enable **TX1** on every band where the amp will be used; set **RF Power** and **Tune Power** sensibly (tune power also gets driven by the bridge).
   - Confirm the internal **ATU shows BYPASS** (the bridge will enforce this, but verify once yourself).
3. **PC next.** Start the bridge (`Start Bridge.bat` on Windows, `./start.sh` on macOS/Linux); in dashboard ⚙ Settings select the radio, both serial ports, and the amp model, then Save, Restart. Confirm the dashboard shows the radio connected, a bound client, and ATU BYPASS.
4. **Amp last**, in **STANDBY**:
   - Amp menu → CAT: protocol **Kenwood**, interface **RS232**, baud **9600** (matching config).
   - The tuner powers up with the amp (watch for the ATU/antenna info on the amp's screen — that confirms the coax-carried control link to the 06AT is alive).
   - Amp ATU menu: assign antennas 1–4 to bands.
5. **Verify CAT link:** QSY in the SDR client; the amp display must follow band and frequency. If not, stop and fix this before any RF.
6. **First tune, amp in STANDBY:** press TUNE on the amp. The bridge should raise a carrier at tune power (~25 W), the 06AT should cycle, and the carrier should drop. Check the dashboard tune history and the debug log.
7. Only when standby tuning is clean: switch to **OPERATE**, tune again, then make a low-power test transmission and watch forward power/SWR on the dashboard.

**Power-down** is the reverse: amp to standby and off first, then everything else in any order.

## Sanity checklist before the first OPERATE tune

- [ ] Amp display follows frequency changes from the SDR client
- [ ] Dashboard: radio connected, client bound, ATU = BYPASS
- [ ] Dashboard: telemetry link connected, amp state shows STANDBY, PA temp ≈ room temperature
- [ ] Standby tune cycle completes and the carrier drops by itself
- [ ] Front-panel power button on the amp still works (proves the remote-port handshake lines are safely unwired)
- [ ] `logs/` contains no `Unhandled command from amp` lines — or you've sent them upstream so rules can be added
