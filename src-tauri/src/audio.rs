use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

pub struct WasapiAudioEngine {
    is_running: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct PcmAudioChunk {
    /// 16-bit signed stereo PCM little-endian (4 bytes per stereo frame)
    pub pcm16_stereo: Vec<u8>,
    pub sample_rate: u32,
}

const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xFFFE;

impl WasapiAudioEngine {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_loopback_capture<F>(&self, on_chunk: F)
    where
        F: Fn(PcmAudioChunk) + Send + 'static,
    {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = self.is_running.clone();

        thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let enumerator: IMMDeviceEnumerator =
                match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    Ok(e) => e,
                    Err(err) => {
                        eprintln!("[WASAPI] Failed to init enumerator: {:?}", err);
                        is_running.store(false, Ordering::SeqCst);
                        return;
                    }
                };

            let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                Ok(d) => d,
                Err(err) => {
                    eprintln!("[WASAPI] Failed to get default audio endpoint: {:?}", err);
                    is_running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[WASAPI] Failed to activate audio client: {:?}", err);
                    is_running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let wave_format_ptr = match audio_client.GetMixFormat() {
                Ok(f) => f,
                Err(err) => {
                    eprintln!("[WASAPI] Failed to get mix format: {:?}", err);
                    is_running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let format_tag = (*wave_format_ptr).wFormatTag;
            let sample_rate = (*wave_format_ptr).nSamplesPerSec;
            let channels = (*wave_format_ptr).nChannels.max(1);
            let bits_per_sample = (*wave_format_ptr).wBitsPerSample;

            // Detect IEEE Float vs 16-bit PCM (including WAVEFORMATEXTENSIBLE where SubFormat first u16 is 3 for float)
            let is_float = if format_tag == WAVE_FORMAT_IEEE_FLOAT_TAG {
                true
            } else if format_tag == WAVE_FORMAT_PCM_TAG {
                false
            } else if format_tag == WAVE_FORMAT_EXTENSIBLE_TAG && (*wave_format_ptr).cbSize >= 22 {
                // WAVEFORMATEXTENSIBLE: SubFormat starts at byte offset 24 (after 18-byte WAVEFORMATEX + 6 bytes)
                let base_ptr = wave_format_ptr as *const u8;
                let subformat_tag = u16::from_le_bytes([*base_ptr.add(24), *base_ptr.add(25)]);
                subformat_tag == WAVE_FORMAT_IEEE_FLOAT_TAG || bits_per_sample == 32
            } else {
                bits_per_sample == 32
            };

            let buffer_duration: i64 = 500_000; // 50ms low-latency buffer
            let init_res = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration,
                0,
                wave_format_ptr,
                None,
            );

            if init_res.is_err() {
                eprintln!("[WASAPI] Loopback init failed: {:?}", init_res);
                CoTaskMemFree(Some(wave_format_ptr as _));
                CoUninitialize();
                return;
            }

            let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[WASAPI] Failed to get capture client: {:?}", err);
                    CoTaskMemFree(Some(wave_format_ptr as _));
                    CoUninitialize();
                    return;
                }
            };

            let _ = audio_client.Start();
            println!(
                "[WASAPI] Game audio loopback running ({sample_rate}Hz, {channels}ch, {bits_per_sample}-bit, float={is_float})"
            );

            let mut last_packet_instant = Instant::now();
            // Reusable conversion buffer to keep heap allocations near zero (<16MB RAM guarantee)
            let mut pcm16_out: Vec<u8> = Vec::with_capacity(4096);

            while is_running.load(Ordering::Relaxed) {
                let mut packet_size = capture_client.GetNextPacketSize().unwrap_or(0);
                let mut read_any = false;

                while packet_size > 0 {
                    let mut data_ptr: *mut u8 = std::ptr::null_mut();
                    let mut frames_read: u32 = 0;
                    let mut flags: u32 = 0;

                    let hr = capture_client.GetBuffer(
                        &mut data_ptr,
                        &mut frames_read,
                        &mut flags,
                        None,
                        None,
                    );

                    if hr.is_ok() && frames_read > 0 {
                        read_any = true;
                        last_packet_instant = Instant::now();
                        let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data_ptr.is_null();

                        pcm16_out.clear();
                        pcm16_out.reserve((frames_read as usize) * 4);

                        if silent {
                            pcm16_out.resize((frames_read as usize) * 4, 0u8);
                        } else if is_float && bits_per_sample == 32 {
                            let ch = channels as usize;
                            let floats = std::slice::from_raw_parts(
                                data_ptr as *const f32,
                                (frames_read as usize) * ch,
                            );
                            for frame in floats.chunks_exact(ch) {
                                let l = frame[0].clamp(-1.0, 1.0);
                                let r = if ch > 1 { frame[1].clamp(-1.0, 1.0) } else { l };
                                let l_i16 = (l * 32767.0) as i16;
                                let r_i16 = (r * 32767.0) as i16;
                                pcm16_out.extend_from_slice(&l_i16.to_le_bytes());
                                pcm16_out.extend_from_slice(&r_i16.to_le_bytes());
                            }
                        } else if bits_per_sample == 16 {
                            let ch = channels as usize;
                            let samples = std::slice::from_raw_parts(
                                data_ptr as *const i16,
                                (frames_read as usize) * ch,
                            );
                            for frame in samples.chunks_exact(ch) {
                                let l = frame[0];
                                let r = if ch > 1 { frame[1] } else { l };
                                pcm16_out.extend_from_slice(&l.to_le_bytes());
                                pcm16_out.extend_from_slice(&r.to_le_bytes());
                            }
                        } else {
                            pcm16_out.resize((frames_read as usize) * 4, 0u8);
                        }

                        on_chunk(PcmAudioChunk {
                            pcm16_stereo: pcm16_out.clone(),
                            sample_rate,
                        });

                        let _ = capture_client.ReleaseBuffer(frames_read);
                    } else {
                        break;
                    }

                    packet_size = capture_client.GetNextPacketSize().unwrap_or(0);
                }

                // When WASAPI Loopback is idle (no audio playing for >20ms), emit 20ms of stereo silence
                // so the MP4 AAC audio track stays 100% continuous and frame-locked with video!
                if !read_any && last_packet_instant.elapsed() >= Duration::from_millis(20) {
                    last_packet_instant = Instant::now();
                    let silent_frames = (sample_rate / 50) as usize; // 20ms of frames
                    on_chunk(PcmAudioChunk {
                        pcm16_stereo: vec![0u8; silent_frames * 4],
                        sample_rate,
                    });
                }

                thread::sleep(Duration::from_millis(5));
            }

            let _ = audio_client.Stop();
            CoTaskMemFree(Some(wave_format_ptr as _));
            CoUninitialize();
        });
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }
}
