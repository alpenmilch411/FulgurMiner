# FulgurMiner — GUI Control Panel

A tiny, zero-dependency local control panel for solo-mining BrowserCoin with
[FulgurMiner](https://github.com/alpenmilch411/FulgurMiner). It wraps the headless
`npm run mine` process in a polished dark-theme web UI: one-click start/stop, live
hashrate / height / difficulty / uptime, CPU-core capping, engine/mode selection,
an **editable payout address**, a **Solo ⇄ Pool switch** (FulgurPool or a custom pool
URL), your **confirmed wallet balance**, and a **live "Est. blocks/day"** readout
computed from the chain's compact difficulty bits and a smoothed hashrate.

Runs on **Windows, macOS, and Linux**. Built with Node built-ins only — no
`npm install` for the panel itself.

```
gui/
  server.mjs   # http server (127.0.0.1:7311): spawns/kills the miner, parses its
               # stdout for metrics, reads the wallet balance, serves the JSON API
               # + the page. Built-ins only, cross-platform.
  index.html   # single-page dark UI (vanilla JS, polls /api/status once a second)
  install-shortcut.mjs   # puts a double-click "FulgurMiner" icon on your Desktop
FulgurMiner-Windows.bat  # double-click launcher — Windows
FulgurMiner-macOS.command  # double-click launcher — macOS
FulgurMiner-Linux.sh     # launcher — Linux (chmod +x once)
```

## Install (Windows / macOS / Linux)

Same three steps on every OS:

**1. Install Node.js ≥ 20.6** — from [nodejs.org](https://nodejs.org) (or Homebrew /
your package manager). Check with `node --version`.

**2. Get the code and its dependencies:**

```bash
git clone https://github.com/alpenmilch411/FulgurMiner.git
cd FulgurMiner
npm install
```

**3. (Optional) the faster native engine** — needs the [Rust toolchain](https://rustup.rs)
(Windows installs the MSVC build tools with it; macOS may need `xcode-select --install`;
Linux needs a C toolchain like `build-essential`). Build it once:

```bash
cd native/brc-pow && cargo build --release && cd ../..
```

Skip this and the panel uses the portable WASM engine — nothing blocks.

### Add a Desktop shortcut (recommended)

```bash
npm run install-shortcut
```

Drops a double-click **FulgurMiner** icon on your Desktop, pointing at the right
launcher for your OS:

- **Windows** → `FulgurMiner.lnk` (via WScript.Shell)
- **macOS** → `FulgurMiner.command` (symlink — stays in sync with the repo)
- **Linux** → `FulgurMiner.desktop` on the Desktop **and** in your app menu (marked
  trusted for GNOME)

## Run

Double-click the Desktop shortcut — or use the launcher in the repo, or the CLI:

```bash
node gui/server.mjs        # or: npm run gui
# then open http://localhost:7311
```

The per-OS launchers (`FulgurMiner-Windows.bat` · `FulgurMiner-macOS.command` ·
`FulgurMiner-Linux.sh`) are identical in behavior — self-locate the repo, start the
server if it isn't already running, poll the port until it's up, then open the panel —
and all serve the **same** `index.html`, so the panel looks and works identically on
every OS.

## What it does

- **Spawns `npm run mine`** with the env the headless miner needs (it does **not**
  read `.env.local`): `MINER_PUBKEY` (your payout address), `MINER_POOL`
  (`solo`, or the pool URL when **Pool** is selected), `FULGUR_TUI=0`,
  `FULGUR_NO_UPDATE_CHECK=1`, plus `MINER_NATIVE` / `MINER_SMART` / `MINER_WORKERS` /
  `MINER_THROTTLE` from the current settings.
- **Editable payout address & Solo/Pool switch.** Change the 64-hex address in the UI
  (an invalid entry is rejected and the current one kept — never silently reset). Pick
  **Solo** (mine whole blocks to your address) or **Pool** (FulgurPool by default, or
  any pool URL). In pool mode the panel parses the miner's reported hashrate, shares,
  and running earnings (earned / pending / paid) and shows those in place of the
  blocks/day estimate.
- **Cross-platform process control:**
  - *POSIX (macOS/Linux):* the child is its own process group (`detached: true`) and
    is stopped by killing the whole group (`process.kill(-pid, 'SIGKILL')`).
  - *Windows:* the child is spawned via the shell (`.cmd` needs it) and stopped with a
    **synchronous** `taskkill /PID <pid> /T /F` — run sync, and without pre-killing the
    root, so the tree (cmd → npm → cmd → tsx → workers) never orphans.
- **Confirmed wallet balance** read from the miner's own verified chain-state snapshot
  at `~/.fulgurminer/snapshot-*.json` (rows of `[address, balanceWei, nonce]` at the
  finalized anchor; `1 BRC = 1e8 wei`). No balance API exists — the wallet app runs a
  full node — so this is the locally-validated, confirmed balance. The ~10 MB file is
  parsed lazily and re-read only when its mtime changes.
- **Live metrics** by parsing the miner's plain-mode stdout (sync %, synced height,
  grind backend, and the `h=… diff=… hps:…` hot line). Tracks now/avg/peak hashrate,
  height, difficulty, blocks found, uptime, and status.
- **Est. blocks/day** (server-side, every poll): decodes the Bitcoin-style compact
  `bits`, computes `p = target / 2²⁵⁶`, then `blocksPerDay = hashrate · p · 86400`
  (independent of network size). Shows `≈ X / day`, `one every ~Yh`, `~Z BRC/day`.
- **Settings persist** to `gui/state.json` (gitignored). Changing a setting while
  mining restarts the child so it picks up the new env (fast — the chain is cached
  in `~/.fulgurminer/`).
- **Stays awake** while the panel is open, per OS (best-effort, no-ops if unavailable):
  macOS `caffeinate -i -m -s` (works on battery too), Linux `systemd-inhibit`, Windows
  `SetThreadExecutionState` via a small PowerShell loop.
- Binds to **127.0.0.1 only**.

## API

| Method | Path           | Purpose                                            |
|--------|----------------|----------------------------------------------------|
| GET    | `/api/status`  | full live state + balance + computed est. blocks/day |
| POST   | `/api/start`   | start the miner                                    |
| POST   | `/api/stop`    | stop the miner (kills the whole process tree)      |
| POST   | `/api/config`  | update `{engine, mode, workers, throttle, wallet, pool, poolUrl}` |

`/api/status` includes `balance: { brc, anchorHeight }` (or `null` until a snapshot
exists), `pool` (`solo`/`pool`) + `poolUrl`, `poolStats: { earned, pending, paid }`
(BRC, in pool mode), and `platform` (`win32` / `darwin` / `linux`).

## Notes

- Default engine = **native (Rust)**, mode = **Smart Max**, workers = **cores − 1**.
- **No payout wallet is baked in.** Enter your 64-hex address in the panel (or via
  `POST /api/config`); mining refuses to start until a valid address is set.
- The balance is the **confirmed** (finalized) balance; freshly mined block rewards
  appear once the block matures and the snapshot advances past it.
- Solo rewards are **high-variance (Poisson)**: the est/day is a long-run average,
  not a schedule. Smart Max runs every core hard — watch CPU heat.
