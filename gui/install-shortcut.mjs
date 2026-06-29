// gui/install-shortcut.mjs — put a double-click "FulgurMiner" shortcut on the
// Desktop, pointing at the right launcher for this OS. Zero-dependency.
//
//   node gui/install-shortcut.mjs        # or: npm run install-shortcut
//
//   Windows → %Desktop%\FulgurMiner.lnk  → FulgurMiner-Windows.bat  (WScript.Shell)
//   macOS   → ~/Desktop/FulgurMiner.command  (symlink to FulgurMiner-macOS.command)
//   Linux   → ~/Desktop/FulgurMiner.desktop + ~/.local/share/applications entry
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ASSET_ICON = path.join(REPO, 'assets', 'fulgur-mark.svg'); // used on Linux if present

function ok(msg) { console.log(`✓ ${msg}`); }
function fail(msg) { console.error(`✗ ${msg}`); process.exitCode = 1; }

function installWindows() {
  const bat = path.join(REPO, 'FulgurMiner-Windows.bat');
  if (!existsSync(bat)) return fail(`launcher not found: ${bat}`);
  // Resolve the real Desktop (handles OneDrive redirection) and write the .lnk
  // via WScript.Shell. Paths are passed through env vars to avoid quoting issues.
  const ps = [
    "$d=[Environment]::GetFolderPath('Desktop')",
    "$lnk=Join-Path $d 'FulgurMiner.lnk'",
    "$w=New-Object -ComObject WScript.Shell",
    "$s=$w.CreateShortcut($lnk)",
    "$s.TargetPath=$env:FM_BAT",
    "$s.WorkingDirectory=$env:FM_REPO",
    "$s.IconLocation=\"$env:SystemRoot\\System32\\imageres.dll,109\"",
    "$s.Description='FulgurMiner — BrowserCoin mining control panel'",
    "$s.Save()",
    "Write-Output $lnk",
  ].join(';');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, FM_BAT: bat, FM_REPO: REPO }, encoding: 'utf8' });
  if (r.status === 0) ok(`Desktop shortcut created: ${(r.stdout || '').trim()}`);
  else fail(`could not create shortcut: ${(r.stderr || r.error || 'unknown').toString().trim()}`);
}

function installMac() {
  const cmd = path.join(REPO, 'FulgurMiner-macOS.command');
  if (!existsSync(cmd)) return fail(`launcher not found: ${cmd}`);
  const link = path.join(os.homedir(), 'Desktop', 'FulgurMiner.command');
  try {
    if (existsSync(link)) rmSync(link);
    symlinkSync(cmd, link);
    try { chmodSync(cmd, 0o755); } catch {}
    ok(`Desktop shortcut created: ${link}`);
  } catch (e) {
    fail(`could not create shortcut: ${e.message}`);
  }
}

function installLinux() {
  const sh = path.join(REPO, 'FulgurMiner-Linux.sh');
  if (!existsSync(sh)) return fail(`launcher not found: ${sh}`);
  try { chmodSync(sh, 0o755); } catch {}
  const icon = existsSync(ASSET_ICON) ? ASSET_ICON : 'utilities-terminal';
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=FulgurMiner',
    'Comment=BrowserCoin mining control panel',
    `Exec=${sh}`,
    `Icon=${icon}`,
    `Path=${REPO}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n');

  const targets = [];
  const apps = path.join(os.homedir(), '.local', 'share', 'applications');
  const desktop = path.join(os.homedir(), 'Desktop');
  try { mkdirSync(apps, { recursive: true }); targets.push(path.join(apps, 'fulgurminer.desktop')); } catch {}
  if (existsSync(desktop)) targets.push(path.join(desktop, 'FulgurMiner.desktop'));
  if (!targets.length) return fail('no Desktop or applications dir found');

  let wrote = 0;
  for (const t of targets) {
    try {
      writeFileSync(t, entry);
      chmodSync(t, 0o755);
      // GNOME: mark the launcher trusted so it runs without the "Allow Launching" prompt.
      spawnSync('gio', ['set', t, 'metadata::trusted', 'true'], { stdio: 'ignore' });
      ok(`shortcut written: ${t}`);
      wrote++;
    } catch (e) {
      console.error(`  (skipped ${t}: ${e.message})`);
    }
  }
  if (!wrote) fail('could not write any shortcut');
}

console.log('FulgurMiner — installing Desktop shortcut…');
if (process.platform === 'win32') installWindows();
else if (process.platform === 'darwin') installMac();
else if (process.platform === 'linux') installLinux();
else fail(`unsupported platform: ${process.platform}`);
