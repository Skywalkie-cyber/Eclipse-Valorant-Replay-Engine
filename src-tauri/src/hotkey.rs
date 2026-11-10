use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;
use windows_sys::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_HOTKEY, WM_KEYDOWN, WM_SYSKEYDOWN,
};

static TRIGGER_SENDER: std::sync::OnceLock<UnboundedSender<()>> = std::sync::OnceLock::new();
static TARGET_KEY: AtomicU32 = AtomicU32::new(0x77); // VK_F8
static LAST_TRIGGER_MS: AtomicU32 = AtomicU32::new(0);

const HOTKEY_ID: i32 = 0x0F80;
const MOD_NOREPEAT: u32 = 0x4000;

pub struct HotkeyManager {
    is_running: Arc<AtomicBool>,
}

impl HotkeyManager {
    pub fn new(trigger_tx: UnboundedSender<()>, initial_key: u32) -> Self {
        let _ = TRIGGER_SENDER.set(trigger_tx);
        TARGET_KEY.store(initial_key, Ordering::Relaxed);
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_key(&self, vk_code: u32) {
        TARGET_KEY.store(vk_code, Ordering::Relaxed);
    }

    pub fn start(&self) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = self.is_running.clone();

        thread::spawn(move || unsafe {
            let target = TARGET_KEY.load(Ordering::Relaxed);

            // Layer 1: OS-Level Kernel Hotkey Registration (Bypasses UIPI & Fullscreen locks)
            let reg_ok = RegisterHotKey(0, HOTKEY_ID, MOD_NOREPEAT, target);
            if reg_ok == 0 {
                println!("[Hotkey Engine] RegisterHotKey fallback to WH_KEYBOARD_LL hook");
            } else {
                println!("[Hotkey Engine] Kernel RegisterHotKey active for VK 0x{:X}", target);
            }

            // Layer 2: Low-Level Global Keyboard Hook (Direct raw hardware scancode intercept)
            let hook: HHOOK = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(ll_keyboard_proc),
                0 as HINSTANCE,
                0,
            );

            if hook == 0 && reg_ok == 0 {
                eprintln!("[Hotkey Engine Error] Failed to install keyboard listener");
                is_running.store(false, Ordering::SeqCst);
                return;
            }

            println!("[Hotkey Engine] Dual-layer global F8 listener active (Exclusive Fullscreen Safe)");

            let mut msg: MSG = std::mem::zeroed();
            while is_running.load(Ordering::Relaxed) && GetMessageW(&mut msg, 0, 0, 0) > 0 {
                if msg.message == WM_HOTKEY && msg.wParam == HOTKEY_ID as usize {
                    Self::dispatch_trigger();
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if hook != 0 {
                UnhookWindowsHookEx(hook);
            }
            if reg_ok != 0 {
                UnregisterHotKey(0, HOTKEY_ID);
            }
        });
    }

    pub fn dispatch_trigger() {
        // High-precision debouncing: suppress duplicate triggers within 800ms
        let now_ms = (Instant::now().elapsed().as_millis() & 0xFFFF_FFFF) as u32;
        let last = LAST_TRIGGER_MS.swap(now_ms, Ordering::SeqCst);
        if now_ms.saturating_sub(last) < 800 && last != 0 {
            return;
        }

        if let Some(tx) = TRIGGER_SENDER.get() {
            println!("[Hotkey Engine] Global trigger dispatched!");
            let _ = tx.send(());
        }
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }
}

unsafe extern "system" fn ll_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 && (w_param == WM_KEYDOWN as WPARAM || w_param == WM_SYSKEYDOWN as WPARAM) {
        let kbd_struct = *(l_param as *const KBDLLHOOKSTRUCT);
        let target = TARGET_KEY.load(Ordering::Relaxed);

        if kbd_struct.vkCode == target {
            HotkeyManager::dispatch_trigger();
            return 1; // Consume key event so Windows never beeps or forwards unhandled hotkey
        }
    }

    CallNextHookEx(0, n_code, w_param, l_param)
}

