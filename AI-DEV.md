# Working on bt-sensors-plugin-sk with Claude Code

This file describes how the maintainers and contributors use Claude Code on this codebase. It is opinionated about *this* codebase, not about Claude Code in general; the patterns here have been validated by real PRs (see #142, #143, #144, #145).

Two workflows are covered:

1. **Adding a new sensor class.** Building support for a new Bluetooth device.
2. **Cross-cutting review and cleanup.** Finding latent bugs, leaks, and hygiene issues across many existing sensors at once.

Both assume Claude Code (or another agent-based AI coding tool with comparable capabilities). Some sections reference specific Claude Code features such as skills (`/simplify`), sub-agents, and agent teams.

---

## Workflow 1: adding a new sensor class

The plugin is a collection of sensor classes under `sensor_classes/`, each one extending `BTSensor` and handling one device family. New classes follow well-established patterns, so Claude's main job is recognizing the right pattern and copying it carefully, not designing something new.

### Capture real device traffic first

This is the single most important step. Without real packets, you and Claude are both guessing.

- **Android HCI snoop log + vendor app** is the gold standard. Enable Developer Options on Android, turn on "Bluetooth HCI snoop log," use the vendor's app for 30 to 60 seconds pressing every button, then `adb pull /sdcard/Android/data/btsnoop_hci.log` and open in Wireshark. Filter on `bluetooth.addr == XX:XX:XX:XX:XX:XX`. Look for `ATT Write Request` (commands), `ATT Handle Value Notification` (push data), `ATT Read Response` (pull data), and `Advertising Data` (broadcast). Note what the vendor app displays at the moment each packet appears: that is the ground truth your decoder must match.
- **nRF Connect** is the fallback if there is no vendor app. Scan, connect, walk every service and characteristic, read each readable one, enable notifications on each notifiable one, screenshot hex with the matching device-display reading.

Keep the captures around. You will use them again to validate the decoder before touching real hardware.

### Have Claude pick a pattern from existing classes

Three reference implementations cover most of the design space:

- `sensor_classes/VictronSmartLithium.js`: advertising data with AES-CTR encryption.
- `sensor_classes/JBDBMS.js`: GATT with command/response protocol.
- `sensor_classes/RenogyBattery.js`: GATT with Modbus-style register reads and polling.

A useful prompt: *"I'm adding a new sensor class for `<device>`. It uses `<advertising | GATT notifications | GATT polling>`. Read the three reference classes, summarize the pattern that fits best, and use it as the template."* Claude will read the actual files and report back, which is much better than improvising a structure from scratch.

### Implementation order

1. **Skeleton class.** Extends `BTSensor`, sets `static Domain`, `static Manufacturer`, `static Description`, `static ImageFile`. Empty `initSchema()`.
2. **`identify(device)`.** For advertising devices, match on manufacturer ID plus any disambiguating bytes. For GATT, match on advertised service UUID. Verify by running the plugin and confirming the device shows up under the right class.
3. **Schema.** In `initSchema()`, call `addDefaultPath()` for standard SignalK paths (voltage, current, SoC, temperature), `addMetadatum()` for device-specific paths, and `addDefaultParam()` for configurable parameters like `batteryID`. Each path's `.read` function takes a `Buffer` and returns the decoded value.
4. **Decoders.** Implement the `.read` functions using `buffer.readInt16LE`, `readUInt16BE`, etc. Match endianness to what your captured packets show.
5. **GATT lifecycle (if applicable).** `hasGATT()` returns true, `usingGATT()` returns the configured flag, `initGATTConnection()` discovers services and characteristics, `initGATTNotifications()` or `initGATTInterval()` sets up the data flow, `emitGATT()` parses incoming buffers and calls `emitValuesFrom(buffer)`. Implement `deactivateGATT()` for cleanup.
6. **Register the class.** Add to `classLoader.js` so it loads at startup.

### Verify against captured packets before touching hardware

`BTSensor` provides `_test()` for feeding a captured hex packet into the decoder and printing the parsed values. Confirm the output matches what the vendor app showed at the moment the packet was captured. Mismatches almost always come down to one of:

- wrong endianness (off by 256x or byte-swapped),
- wrong sign (UInt vs Int),
- wrong scale factor,
- wrong byte offset.

A passing `_test()` is necessary but not sufficient: it does not catch reconnect bugs, lifecycle leaks, or characteristic-discovery edge cases. Real-device verification is the only way to be sure.

### Run `/simplify` before opening the PR

Before pushing, ask Claude Code to run `/simplify` on the diff. It looks for reuse opportunities (someone else already wrote a similar decoder), tightens overengineered code, and catches issues introduced during the change itself. Cheap and worth doing every time.

---

## Workflow 2: cross-cutting review and cleanup

The codebase has 100+ sensor classes, mostly contributed device-by-device, so the same kinds of bugs tend to recur across many files: comma-expressions where function calls were meant, missing `await`s, `for` loops with the condition and update slots swapped, listeners that compound across reconnects. A targeted multi-agent pass catches a lot of these in one go.

### The pattern (recently used for PRs #142, #143, #144, #145)

1. **Spawn an agent team with non-overlapping lenses.** Each teammate gets one bug class to look for. Useful lenses for this codebase:
   - **Silent value-corruption.** Decoders that return wrong numbers without throwing: comma-expression bugs, missing `return` in arrow function bodies, wrong scale factors, bitwise-vs-arithmetic operator confusion (`^` instead of `**`).
   - **Latent runtime crashes.** Bare `varName` instead of `this.varName`, missing `await`, `buffer.size` (does not exist on Node `Buffer`) instead of `buffer.length`, copy-paste typos that throw `ReferenceError` on first invocation.
   - **Connection-lifecycle and resource leaks.** `setInterval` cleared with `clearTimeout`, listeners that compound across reconnects, command sequences that overlap on a single characteristic, retry loops with broken exit conditions.
   - **Security and hygiene.** `eval`, `debugger`, dead code, unused imports, implicit globals, duplicate declarations.

   Agent teams beat single sub-agents because teammates can challenge each other's findings via the team mailbox before reporting up to you. False positives drop dramatically. Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json` and spawn three teammates with distinct lenses in a single turn so they run concurrently.

2. **Triage and group.** Have the agents pool every finding, dedupe overlap, and rank by blast radius and confidence. **Drop anything that cannot be verified from the code alone.** Byte-offset claims that need hardware to validate, claims about files on a live in-flight branch, decoder behavior that depends on what a real device actually emits: skip those rather than guess. Better to miss a real bug than to merge a wrong "fix."

3. **Group findings into themed PRs, not one big PR.** Different bug classes are different review burdens for the maintainer. PR #142 (silent value bugs) and PR #143 (runtime crashes) need different mental models from a reviewer; mixing them makes both harder to evaluate. Aim for roughly 5 to 10 fixes per PR with a coherent theme.

4. **`/simplify` pass per PR.** Same as in workflow 1: run before opening each PR. It often catches an over-engineered patch and trims it down before it leaves your machine.

5. **Per-PR test plan tied to real hardware.** End every PR description with a checklist of things to verify on the actual devices. The maintainer is the one with the hardware; the test plan is the merge bar, not filler. PRs without a test plan put all the verification cost on the maintainer, and most maintainers will deprioritize them.

6. **Manual review before push.** Read every diff yourself. Hold back changes that look plausible to the agents but feel off on a second read. "Claude Code was involved" can mean very different things depending on whether a human looked at the diff before pushing.

### What this workflow does NOT do well

- **Architectural changes.** Agent teams find local bugs. Refactors and design shifts should be brainstormed with a human first, not handed to an agent team. Use the `brainstorming` skill for that.
- **Behavior changes that need hardware verification.** If a fix's correctness depends on what the device actually emits, the agents' confidence is meaningless. Either verify on hardware before opening the PR or skip the change.
- **Anything on an active feature branch.** Run this against `main` only. Running it across in-flight branches creates merge nightmares and steps on the contributor's work.

---

## Appendix: tactical patterns

### Buffer reading

```js
buffer.readUInt16LE(offset)   // unsigned 16-bit little-endian
buffer.readInt16LE(offset)    // signed
buffer.readUInt16BE(offset)   // big-endian
buffer.readUInt8(offset)      // single byte
buffer.readInt8(offset)
buffer.readUInt32LE(offset)
```

Common decoder shapes:

```js
// Voltage: 0.01V units, unsigned LE
.read = (buffer) => buffer.readUInt16LE(2) / 100

// Current: 0.01A units, signed LE (positive = charging)
.read = (buffer) => buffer.readInt16LE(4) / 100

// Temperature: 0.1°C, signed, returned as Kelvin
.read = (buffer) => buffer.readInt16LE(7) / 10 + 273.15

// SoC: percent as ratio
.read = (buffer) => buffer.readUInt8(6) / 100

// "Not available" sentinel handling
.read = (buffer) => {
  const v = buffer.readInt16LE(8)
  return v === 0x7FFF ? NaN : v / 10
}
```

### SignalK paths

Standard battery paths (units in parentheses):

```
electrical.batteries.{id}.voltage                    (V)
electrical.batteries.{id}.current                    (A, +ve = charging)
electrical.batteries.{id}.temperature                (K)
electrical.batteries.{id}.capacity.stateOfCharge     (ratio 0-1)
electrical.batteries.{id}.capacity.remaining         (C, coulombs)
electrical.batteries.{id}.capacity.actual            (C, total)
electrical.batteries.{id}.cycles                     (count)
electrical.batteries.{id}.lifetimeDischarge          (C)
electrical.batteries.{id}.lifetimeRecharge           (C)
```

Per-cell paths use `electrical.batteries.{id}.cell[N].voltage`.

### Common gotchas

| Symptom | Likely cause |
|---------|--------------|
| Values 256x off | Wrong endianness |
| Negative when charging | UInt vs Int, or signed value being read unsigned |
| Always the same constant | Wrong byte offset, OR a `(x, y)` comma-expression where a function call was intended |
| `undefined` from a decoder | Arrow function body uses `{ ... }` but is missing `return` |
| `Cannot read properties of null` after disconnect | GATT handle accessed without checking that `_gattConnection` is still non-null |
| Listener count grows over time | Override missing `super.propertiesChanged()` call, or a reconnect path that re-adds listeners without removing the old ones |

### Capturing HCI logs (quick reference)

```bash
# Android: enable in Developer Options, then
adb pull /sdcard/Android/data/btsnoop_hci.log
# Or, on newer Android:
adb bugreport
# then extract: FS/data/misc/bluetooth/logs/btsnoop_hci.log

# Wireshark filter:
bluetooth.addr == XX:XX:XX:XX:XX:XX
# look at: ATT Write Request, ATT Handle Value Notification,
#          ATT Read Response, Advertising Data

# tshark for batch extraction:
tshark -r btsnoop_hci.log -Y "btatt && bluetooth.addr == XX:XX:XX:XX:XX:XX" \
  -T fields -e btatt.value
```

### bluetoothctl quick scan

```bash
bluetoothctl
scan on
# wait for the device to appear
info XX:XX:XX:XX:XX:XX
# look for: ManufacturerData, ServiceData, UUIDs
```

---

## Resources

- [SignalK specification](http://signalk.org/specification/latest/doc/vesselsBranch.html)
- [Bluetooth GATT specifications](https://www.bluetooth.com/specifications/specs/)
- [Node.js Buffer API](https://nodejs.org/api/buffer.html)
- `README.md`: plugin overview
- `BTSensor.js`: base class for all sensor implementations
- `sensor_classes/DEVELOPMENT.md`: older device-style guide; some overlap with this file
