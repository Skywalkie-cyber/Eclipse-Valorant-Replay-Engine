use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1,
    IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

pub struct DxgiCaptureEngine {
    is_capturing: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug)]
struct WindowCropRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    is_game_active: bool,
}

impl DxgiCaptureEngine {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Queries the foreground window to detect if Valorant is active and obtain its exact game window viewport.
    /// This guarantees GAME-ONLY capture: desktop, companion app, browser, and Discord are NEVER recorded.
    unsafe fn get_game_window_bounds(screen_w: u32, screen_h: u32) -> WindowCropRect {
        // High-performance 1-second cached status: eliminates 60 FPS kernel process snapshot bottlenecks!
        let status = crate::game_detect::get_cached_valorant_status();
        if !status.is_running {
            // Valorant is not running -> STOP capture, never record desktop
            return WindowCropRect {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
                is_game_active: false,
            };
        }

        let my_pid = std::process::id();
        let fg_hwnd = windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        let mut target_hwnd = 0;

        if fg_hwnd != 0 {
            let mut fg_pid = 0u32;
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(fg_hwnd, &mut fg_pid);

            // NEVER record our own clipper companion app or desktop!
            if fg_pid != 0 && fg_pid != my_pid {
                let is_val_pid = status.pids.contains(&fg_pid) || status.pid == Some(fg_pid);

                let mut class_buf = [0u16; 64];
                let class_len = windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
                    fg_hwnd,
                    class_buf.as_mut_ptr(),
                    class_buf.len() as i32,
                );
                let class_str = String::from_utf16_lossy(&class_buf[..(class_len.max(0) as usize)]);

                let mut title_buf = [0u16; 128];
                let title_len = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
                    fg_hwnd,
                    title_buf.as_mut_ptr(),
                    title_buf.len() as i32,
                );
                let title_str = String::from_utf16_lossy(&title_buf[..(title_len.max(0) as usize)]).to_uppercase();

                // Unreal Engine Valorant window detection:
                // Window class is "UnrealWindow", process is Valorant, and title is VALORANT
                let is_unreal_val = class_str.contains("UnrealWindow") && (
                    is_val_pid || title_str.contains("VALORANT") || title_str.is_empty()
                );

                if is_val_pid || is_unreal_val {
                    target_hwnd = fg_hwnd;
                }
            }
        }

        // If foreground window is not Valorant, user has alt-tabbed (e.g. to Discord, Browser, or Companion App)
        // STRICT GAME-ONLY ISOLATION: Do not record desktop or background when alt-tabbed!
        if target_hwnd == 0 {
            return WindowCropRect {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
                is_game_active: false,
            };
        }

        // Verify game window is visible and not minimized (never record desktop if minimized)
        if windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(target_hwnd) == 0
            || windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(target_hwnd) != 0
        {
            return WindowCropRect {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
                is_game_active: false,
            };
        }

        // Get Valorant's exact client render area (game viewport, excludes window decorations)
        let mut client_rect: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
        windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(target_hwnd, &mut client_rect);

        let mut top_left = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        windows_sys::Win32::Graphics::Gdi::ClientToScreen(target_hwnd, &mut top_left);

        let win_w = (client_rect.right - client_rect.left).max(0) as u32;
        let win_h = (client_rect.bottom - client_rect.top).max(0) as u32;

        if win_w < 100 || win_h < 100 {
            return WindowCropRect {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
                is_game_active: false,
            };
        }

        // Clamp crop bounds within screen buffer and ensure even width/height for H.264 MFT encoder
        let crop_x = (top_left.x.max(0) as u32).min(screen_w.saturating_sub(4));
        let crop_y = (top_left.y.max(0) as u32).min(screen_h.saturating_sub(4));
        let crop_w = (win_w.min(screen_w.saturating_sub(crop_x))) & !1;
        let crop_h = (win_h.min(screen_h.saturating_sub(crop_y))) & !1;

        if crop_w < 100 || crop_h < 100 {
            return WindowCropRect {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
                is_game_active: false,
            };
        }

        WindowCropRect {
            x: crop_x,
            y: crop_y,
            width: crop_w,
            height: crop_h,
            is_game_active: true,
        }
    }

    pub fn start_capture_thread<F>(&self, target_fps: u32, mut on_frame: F)
    where
        F: FnMut(&[u8], u32, u32) + Send + 'static,
    {
        if self.is_capturing.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_capturing = self.is_capturing.clone();
        let frame_interval = Duration::from_nanos(1_000_000_000 / target_fps as u64);

        thread::spawn(move || unsafe {
            while is_capturing.load(Ordering::Relaxed) {
                let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
                    Ok(f) => f,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(1000));
                        continue;
                    }
                };

                let mut chosen = None;

                // Thoroughly search all adapters and outputs to find the active display output that accepts duplication
                'adapter_search: for a_idx in 0..8 {
                    let ad = match factory.EnumAdapters1(a_idx) {
                        Ok(a) => a,
                        Err(_) => break,
                    };

                    for o_idx in 0..8 {
                        let out = match ad.EnumOutputs(o_idx) {
                            Ok(o) => o,
                            Err(_) => break,
                        };

                        let output1: IDXGIOutput1 = match out.cast() {
                            Ok(o) => o,
                            Err(_) => continue,
                        };

                        // Create D3D11 device bound to this specific adapter to prevent E_ACCESSDENIED on multi-GPU systems
                        let adapter_base = ad.cast::<IDXGIAdapter>().ok();
                        let mut dev: Option<ID3D11Device> = None;
                        let mut ctx: Option<ID3D11DeviceContext> = None;

                        let hr = D3D11CreateDevice(
                            adapter_base.as_ref(),
                            D3D_DRIVER_TYPE_UNKNOWN,
                            None,
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            Some(&[D3D_FEATURE_LEVEL_11_0]),
                            D3D11_SDK_VERSION,
                            Some(&mut dev),
                            None,
                            Some(&mut ctx),
                        );

                        if hr.is_err() || dev.is_none() || ctx.is_none() {
                            let _ = D3D11CreateDevice(
                                None,
                                D3D_DRIVER_TYPE_HARDWARE,
                                None,
                                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                Some(&[D3D_FEATURE_LEVEL_11_0]),
                                D3D11_SDK_VERSION,
                                Some(&mut dev),
                                None,
                                Some(&mut ctx),
                            );
                        }

                        if let (Some(d), Some(c)) = (dev, ctx) {
                            match output1.DuplicateOutput(&d) {
                                Ok(dup) => {
                                    println!("[DXGI] DuplicateOutput successfully acquired on Adapter {} Output {}!", a_idx, o_idx);
                                    chosen = Some((d, c, dup));
                                    break 'adapter_search;
                                }
                                Err(_e) => {
                                    // Try next adapter/output
                                    continue;
                                }
                            }
                        }
                    }
                }

                let (d3d_device, d3d_context, duplicator) = match chosen {
                    Some(val) => val,
                    None => {
                        thread::sleep(Duration::from_millis(1500));
                        continue;
                    }
                };

                println!("[DXGI] Game-Only Zero-Copy Capture active at {target_fps} FPS");

                let mut staging_texture: Option<ID3D11Texture2D> = None;
                let mut tex_width = 0u32;
                let mut tex_height = 0u32;
                let mut packed_frame: Vec<u8> = Vec::new();
                let mut out_w = 0u32;
                let mut out_h = 0u32;

                while is_capturing.load(Ordering::Relaxed) {
                    let start_time = Instant::now();
                    let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                    let mut desktop_resource: Option<IDXGIResource> = None;

                    // Low latency frame acquisition: 16ms matches 60 FPS frame cadence
                    let acquire_res = duplicator.AcquireNextFrame(16, &mut frame_info, &mut desktop_resource);

                    match acquire_res {
                        Ok(()) => {
                            if let Some(res) = desktop_resource {
                                if let Ok(texture) = res.cast::<ID3D11Texture2D>() {
                                    let mut desc = D3D11_TEXTURE2D_DESC::default();
                                    texture.GetDesc(&mut desc);

                                    if staging_texture.is_none() || tex_width != desc.Width || tex_height != desc.Height {
                                        tex_width = desc.Width;
                                        tex_height = desc.Height;

                                        let staging_desc = D3D11_TEXTURE2D_DESC {
                                            Width: tex_width,
                                            Height: tex_height,
                                            MipLevels: 1,
                                            ArraySize: 1,
                                            Format: desc.Format,
                                            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                                            Usage: D3D11_USAGE_STAGING,
                                            BindFlags: 0,
                                            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                                            MiscFlags: 0,
                                        };

                                        let mut new_staging = None;
                                        if d3d_device.CreateTexture2D(&staging_desc, None, Some(&mut new_staging)).is_ok() {
                                            staging_texture = new_staging;
                                        }
                                    }

                                    if let Some(ref staging) = staging_texture {
                                        d3d_context.CopyResource(staging, &texture);

                                        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                                        if d3d_context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).is_ok() {
                                            let src_ptr = mapped.pData as *const u8;
                                            let row_pitch = mapped.RowPitch as usize;

                                            // Game-only bounds check
                                            let bounds = Self::get_game_window_bounds(tex_width, tex_height);

                                            // Only capture frames when the game is active (never leak desktop / other apps)
                                            if bounds.is_game_active {
                                                let crop_w = bounds.width;
                                                let crop_h = bounds.height;
                                                let crop_x = bounds.x;
                                                let crop_y = bounds.y;

                                                if out_w != crop_w || out_h != crop_h {
                                                    out_w = crop_w;
                                                    out_h = crop_h;
                                                    packed_frame.resize((crop_w * crop_h * 4) as usize, 0);
                                                }

                                                let line_bytes = (crop_w * 4) as usize;

                                                // DXGI Desktop Duplication textures are top-down, matching MfVideoRecorder's
                                                // positive MF_MT_DEFAULT_STRIDE (width * 4). Copy top-down (dst_y = y) so recorded
                                                // footage and live HUD combat detection are 100% right-side up.
                                                for y in 0..crop_h as usize {
                                                    let src_y = (crop_y as usize + y).min(tex_height as usize - 1);
                                                    let src_row = src_ptr.add(src_y * row_pitch + (crop_x as usize * 4));
                                                    let dst_row = packed_frame.as_mut_ptr().add(y * line_bytes);
                                                    std::ptr::copy_nonoverlapping(src_row, dst_row, line_bytes);
                                                }

                                                let _ = d3d_context.Unmap(staging, 0);
                                                on_frame(&packed_frame, crop_w, crop_h);
                                            } else {
                                                let _ = d3d_context.Unmap(staging, 0);
                                            }
                                        }
                                    }
                                }
                            }
                            let _ = duplicator.ReleaseFrame();
                        }
                        Err(e) => {
                            if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                                // Screen unchanged: repeat previous frame if game is active so encoder maintains cadence
                                let bounds = Self::get_game_window_bounds(tex_width, tex_height);
                                if bounds.is_game_active && !packed_frame.is_empty() && out_w > 0 && out_h > 0 {
                                    on_frame(&packed_frame, out_w, out_h);
                                }
                            } else if e.code() == DXGI_ERROR_ACCESS_LOST {
                                eprintln!("[DXGI] Display mode change / access lost. Re-acquiring duplication...");
                                thread::sleep(Duration::from_millis(300));
                                break; // Breaks inner loop, drops duplicator, and re-initializes cleanly!
                            }
                        }
                    }

                    let elapsed = start_time.elapsed();
                    if elapsed < frame_interval {
                        thread::sleep(frame_interval - elapsed);
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        self.is_capturing.store(false, Ordering::SeqCst);
    }
}
