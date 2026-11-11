<p align="center">
  <img src="src/assets/eclipse-banner-transparent.png" alt="Eclipse Replay Engine" width="420" />
</p>

<h1 align="center">Eclipse — Valorant Replay Engine</h1>

<p align="center">
  <strong>Hardware-accelerated, zero-latency desktop replay buffer & highlight studio built exclusively for competitive Valorant.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v0.1.1-8B5CF6?style=for-the-badge&logo=github" alt="Release v0.1.1" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20x64-00D48F?style=for-the-badge&logo=windows" alt="Windows 10/11" />
  <img src="https://img.shields.io/badge/Anti--Cheat-100%25%20Vanguard%20Safe-10B981?style=for-the-badge&logo=shield" alt="Vanguard Safe" />
  <img src="https://img.shields.io/badge/Security-Ed25519%20Minisign-7C3AED?style=for-the-badge&logo=keycdn" alt="Signed Updates" />
  <img src="https://img.shields.io/badge/Storage-100%25%20Local-3B82F6?style=for-the-badge" alt="Local Only" />
</p>

---

## ⚡ What is Eclipse?

**Eclipse** is a high-performance, strictly local background clipping companion for Valorant. Designed from the ground up to eliminate FPS drops, input lag, and heavy background RAM bloat, Eclipse continuously spools gameplay footage directly from your GPU framebuffer.

Press **`F8`** during any match to instantly preserve the past **15s to 120s** of action with crisp audio, synchronized killfeed markers, and interactive telemetry — all stored 100% locally on your computer with **zero external telemetry and zero cloud dependency**.

---

## 🚀 Key Features

### 🎮 Direct3D 11 DXGI Zero-Copy Pipeline
- **Zero In-Game FPS Drop**: Captures raw frames directly from Microsoft DXGI Desktop Duplication (`IDXGIOutputDuplication`) into GPU memory (`ID3D11Texture2D`).
- **Hardware Silicon Acceleration**: Utilizes hardware MFT encoders for **NVIDIA NVENC, AMD AMF, and Intel QuickSync**. Software CPU encoding is disabled to safeguard gaming CPU cycles.
- **Game-Only Focus Guard**: Automatically pauses capture when Valorant is minimized or tabbed out. Desktop, private messages, and web browsers are never recorded.

### 🎯 Automatic Combat Telemetry & Timeline Markers
- **Combat Markers**: Reads non-invasive shared combat logs from `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log`.
- **Interactive Scrubber**: Clips automatically tag Headshots, Kills, Deaths, and Clutch plays along the playback scrubber.
- **Agent Recognition**: Automatically resolves your active agent (Jett, Reyna, Cypher, etc.) and account banner for every clip.

### 🔔 Smooth Non-Intrusive HUD Overlay
- **Instant Visual Feedback**: A sleek 3-second animated HUD card slides in from the left when a clip is triggered stating *"time sec clipped via Eclipse"*.
- **Soft Acoustic Confirmation**: Harmonic chime plays through your headset so you know a clip was saved without taking your eyes off the crosshair.
- **Click-Through & Transparent**: Built with `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` to guarantee zero interference with crosshair precision or in-game mouse movement.

### 🔒 Cryptographically Signed In-App Updates
- **Automatic GitHub Update Detection**: Checks for updates directly on launch. If a mandatory update is pushed, Eclipse prompts you to update before continuing.
- **1-Click Seamless Update**: Directly downloads, verifies, and installs the update in the background without needing to manually visit GitHub.
- **Minisign Ed25519 Encryption**: Every release is mathematically signed with a private developer key. Tampered or unauthorized updates are rejected on the spot.

### 🗜️ Ultra-Lean Resource Footprint
- **Circular NVMe/SSD Spooler**: Rolling segment slices keep video buffer heap allocations capped to negligible levels.
- **Minimizes to System Tray**: Easily minimize Eclipse to the Windows system notification tray while in match.

---

## 🛡️ Vanguard & Riot Games ToS Compliance

Eclipse is built strictly following **Riot Games' Third-Party Tool & Developer Policies**:

1. **Zero Memory Scanning**: Does not call `OpenProcess` with memory reading/writing privileges (`PROCESS_VM_READ` or `PROCESS_VM_WRITE`).
2. **Zero DLL Injection**: Does not inject hooks, threads, or libraries into `VALORANT-Win64-Shipping.exe`.
3. **No Unfair Tactical Advantage**: Does not provide radar hacks, wallhacks, crosshair overlays, or automation. It strictly records footage and past combat logs.
4. **Standard Windows OS APIs**: Uses native Windows DirectX duplication, WASAPI loopback, and `RegisterHotKey` / `WH_KEYBOARD_LL`.

> **Riot Games Disclaimer:**  
> *Eclipse isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.*

---

## ⌨️ Hotkeys & Shortcuts

| Hotkey | Action | Context |
| :--- | :--- | :--- |
| **`F8`** | **Save Replay Clip** (Hardware Buffer Highlight) | In-Game / Global |
| **`Space`** | Play / Pause Video Playback | Reviewer |
| **`J` / `←`** | Seek Backward 5 Seconds | Reviewer |
| **`L` / `→`** | Seek Forward 5 Seconds | Reviewer |
| **`[`** | Set Trim Start Marker | Reviewer |
| **`]`** | Set Trim End Marker | Reviewer |
| **`F`** | Toggle Fullscreen Review | Reviewer |
| **`M`** | Toggle Mute Video Audio | Reviewer |

---

## 📥 Installation & Download

1. Download the latest installer from [GitHub Releases](https://github.com/Skywalkie-cyber/Eclipse-Zero-Latency-Valorant-Replay-Highlight-Engine/releases/latest):
   - **Installer**: `Eclipse-Setup.exe`
2. Run the installer and launch **Eclipse**.
3. Launch **Valorant** — Eclipse will automatically detect the game process and begin rolling background capture.
4. Press **`F8`** whenever you make a highlight play!

---

## 🛠️ Architecture & Tech Stack

```
Eclipse/
├── src/                          # Modern SolidJS Frontend (Vite + TailwindCSS)
│   ├── components/
│   │   ├── reviewer/             # Interactive timeline, scrubber & media player
│   │   ├── ClipOverlayNotification.tsx  # In-game HUD notification popup
│   │   ├── UpdateModal.tsx       # Mandatory signed update gate dialog
│   │   └── SettingsPanel.tsx     # Dynamic hardware & storage configuration
│   ├── App.tsx                   # Main window layout with system tray control
│   └── index.css                 # Cyber-neon theme styling & tactile micro-animations
├── src-tauri/                    # Native Rust Engine (Tauri v2 + DirectX 11)
│   ├── src/
│   │   ├── capture.rs            # Zero-copy DXGI desktop duplication (D3D11)
│   │   ├── encoder.rs            # Hardware MFT encoder session (NVENC/AMF/QSV)
│   │   ├── audio.rs              # WASAPI audio loopback & mic mixer
│   │   ├── disk_spooler.rs       # Circular NVMe segmented ring buffer
│   │   ├── game_events.rs        # Vanguard-safe ShooterGame.log combat tailer
│   │   ├── hotkey.rs             # Low-latency Windows global hotkey hook (F8)
│   │   ├── updater.rs            # Ed25519 Minisign cryptographic update engine
│   │   ├── match_sync.rs         # Post-match Riot Client timeline reconciliation
│   │   └── main.rs               # Headless tray daemon & Tauri command dispatcher
│   ├── Cargo.toml                # Native dependencies & Windows SDK bindings
│   └── tauri.conf.json           # Tauri v2 window, updater & capability schema
└── package.json
```

---

## 🏗️ Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- [Rust](https://rustup.rs/) (v1.78 or higher, stable toolchain)
- Visual Studio C++ Build Tools with Windows 10/11 SDK

### 1. Clone the Repository
```bash
git clone https://github.com/Skywalkie-cyber/Eclipse-Zero-Latency-Valorant-Replay-Highlight-Engine.git
cd Eclipse-Zero-Latency-Valorant-Replay-Highlight-Engine
```

### 2. Install Frontend Dependencies
```bash
npm install
```

### 3. Run in Development Mode
```bash
npm run tauri dev
```

### 4. Build Production Installer
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "src-tauri/eclipse-updater.key" -Raw).Trim()
npx tauri build --bundles nsis
```
The compiled installer will be output to:
`src-tauri/target/release/bundle/nsis/Eclipse_0.1.1_x64-setup.exe`

---
