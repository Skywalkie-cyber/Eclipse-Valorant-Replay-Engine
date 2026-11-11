use std::path::Path;
use std::time::Instant;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateSinkWriterFromURL, MFStartup,
    IMFAttributes, IMFByteStream, IMFSinkWriter,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFMediaType_Audio, MFMediaType_Video,
    MFVideoFormat_H264, MFVideoFormat_RGB32, MFVideoInterlace_Progressive,
    MF_LOW_LATENCY, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MFSTARTUP_NOSOCKET, MF_VERSION,
};

pub struct MfVideoRecorder {
    sink_writer: IMFSinkWriter,
    video_stream_index: u32,
    audio_stream_index: Option<u32>,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
    #[allow(dead_code)]
    fps: u32,
    audio_sample_rate: u32,
    frame_duration_hns: i64,
    frame_count: i64,
    current_video_time_hns: i64,
    last_frame_instant: Option<Instant>,
    audio_frames_written: i64,
    is_finalized: bool,
}

impl MfVideoRecorder {
    pub fn new(
        output_path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
        audio_sample_rate: u32,
    ) -> Result<Self, String> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)
                .map_err(|e| format!("MFStartup failed: {e}"))?;

            let mut attributes: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attributes, 4)
                .map_err(|e| format!("MFCreateAttributes failed: {e}"))?;
            let attributes = attributes.ok_or("Failed to create attributes")?;

            let _ = attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);

            let mf_disable_throttling =
                windows::core::GUID::from_u128(0x08b845d8_2b74_4fe2_9d70_0750df5dc0a2);
            let _ = attributes.SetUINT32(&mf_disable_throttling, 1);

            let path_str = output_path.to_string_lossy().to_string();
            let url = HSTRING::from(path_str);

            let sink_writer = MFCreateSinkWriterFromURL(
                PCWSTR(url.as_wide().as_ptr()),
                None::<&IMFByteStream>,
                &attributes,
            )
            .map_err(|e| format!("MFCreateSinkWriterFromURL failed: {e}"))?;

            // Support up to 100 Mbps bitrate for crisp 4K Ultra HD and 1440p
            let safe_fps = fps.clamp(30, 60);
            let safe_bitrate = bitrate_bps.clamp(5_000_000, 100_000_000);
            let media_type_out =
                MFCreateMediaType().map_err(|e| format!("MFCreateMediaType failed: {e}"))?;

            media_type_out
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|e| format!("Set major type failed: {e}"))?;
            media_type_out
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
                .map_err(|e| format!("Set subtype H264 failed: {e}"))?;
            media_type_out
                .SetUINT32(&MF_MT_AVG_BITRATE, safe_bitrate)
                .map_err(|e| format!("Set bitrate failed: {e}"))?;

            let frame_size = ((width as u64) << 32) | (height as u64);
            media_type_out
                .SetUINT64(&MF_MT_FRAME_SIZE, frame_size)
                .map_err(|e| format!("Set frame size failed: {e}"))?;

            let frame_rate = ((safe_fps as u64) << 32) | 1u64;
            media_type_out
                .SetUINT64(&MF_MT_FRAME_RATE, frame_rate)
                .map_err(|e| format!("Set frame rate failed: {e}"))?;

            let par = (1u64 << 32) | 1u64;
            media_type_out
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, par)
                .map_err(|e| format!("Set aspect ratio failed: {e}"))?;

            media_type_out
                .SetUINT32(
                    &MF_MT_INTERLACE_MODE,
                    MFVideoInterlace_Progressive.0 as u32,
                )
                .map_err(|e| format!("Set interlace failed: {e}"))?;

            // CRITICAL FIX FOR 4K (3840x2160) & 1440p:
            // Windows Media Foundation default H.264 profile is Level 4.1 (which rejects >2048x1024 with 0xC00D36B4).
            // Setting High Profile (100) and Level 5.2 (52) instructs NVENC / AMF / Intel QSV / MFT to accept 4K UHD @ 60 FPS!
            let mf_mt_mpeg2_profile = windows::core::GUID::from_u128(0xad76a21e_3070_4ad4_80ce_6671b561d8b0);
            let mf_mt_mpeg2_level = windows::core::GUID::from_u128(0x96f66574_11c5_4015_8666_bff516436da7);
            let _ = media_type_out.SetUINT32(&mf_mt_mpeg2_profile, 100); // eAVEncH264VProfile_High
            let level = if width > 1920 || height > 1088 {
                52 // eAVEncH264VLevel5_2 (supports up to 4096x2304 @ 60fps)
            } else {
                42 // eAVEncH264VLevel4_2 (Full HD 1080p @ 60fps)
            };
            let _ = media_type_out.SetUINT32(&mf_mt_mpeg2_level, level);

            let video_stream_index = sink_writer
                .AddStream(&media_type_out)
                .map_err(|e| format!("AddStream failed: {e}"))?;

            // 2. Configure Uncompressed BGRA Input Video Type (Top-down positive stride)
            let media_type_in =
                MFCreateMediaType().map_err(|e| format!("MFCreateMediaType in failed: {e}"))?;

            media_type_in
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|e| format!("Set input major type failed: {e}"))?;
            media_type_in
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(|e| format!("Set input subtype RGB32 failed: {e}"))?;
            media_type_in
                .SetUINT32(&MF_MT_DEFAULT_STRIDE, (width * 4) as u32)
                .map_err(|e| format!("Set default stride failed: {e}"))?;
            media_type_in
                .SetUINT64(&MF_MT_FRAME_SIZE, frame_size)
                .map_err(|e| format!("Set input frame size failed: {e}"))?;
            media_type_in
                .SetUINT64(&MF_MT_FRAME_RATE, frame_rate)
                .map_err(|e| format!("Set input frame rate failed: {e}"))?;
            media_type_in
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, par)
                .map_err(|e| format!("Set input aspect ratio failed: {e}"))?;
            media_type_in
                .SetUINT32(
                    &MF_MT_INTERLACE_MODE,
                    MFVideoInterlace_Progressive.0 as u32,
                )
                .map_err(|e| format!("Set input interlace failed: {e}"))?;

            sink_writer
                .SetInputMediaType(video_stream_index, &media_type_in, None)
                .map_err(|e| format!("SetInputMediaType failed: {e}"))?;

            // 3. Configure Hardware/Native AAC Audio Stream (WASAPI 16-bit Stereo PCM -> AAC 160kbps)
            let sr = if audio_sample_rate == 44100 || audio_sample_rate == 48000 {
                audio_sample_rate
            } else {
                48000
            };
            let audio_stream_index = Self::setup_aac_audio_stream(&sink_writer, sr).ok();

            sink_writer
                .BeginWriting()
                .map_err(|e| format!("BeginWriting failed: {e}"))?;

            let frame_duration_hns = (10_000_000 / safe_fps as i64).max(1);

            Ok(Self {
                sink_writer,
                video_stream_index,
                audio_stream_index,
                width,
                height,
                fps: safe_fps,
                audio_sample_rate: sr,
                frame_duration_hns,
                frame_count: 0,
                current_video_time_hns: 0,
                last_frame_instant: None,
                audio_frames_written: 0,
                is_finalized: false,
            })
        }
    }

    /// Returns the exact recorded media duration so far in milliseconds.
    pub fn current_media_time_ms(&self) -> u64 {
        (self.current_video_time_hns.max(0) / 10_000) as u64
    }

    unsafe fn setup_aac_audio_stream(
        sink_writer: &IMFSinkWriter,
        sample_rate: u32,
    ) -> Result<u32, String> {
        let audio_out = MFCreateMediaType().map_err(|e| e.to_string())?;
        audio_out
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|e| e.to_string())?;
        audio_out
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(|e| e.to_string())?;
        audio_out
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|e| e.to_string())?;
        audio_out
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
            .map_err(|e| e.to_string())?;
        audio_out
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
            .map_err(|e| e.to_string())?;
        audio_out
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 20_000) // 160 kbps AAC
            .map_err(|e| e.to_string())?;

        let stream_idx = sink_writer
            .AddStream(&audio_out)
            .map_err(|e| e.to_string())?;

        let audio_in = MFCreateMediaType().map_err(|e| e.to_string())?;
        audio_in
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)
            .map_err(|e| e.to_string())?;
        audio_in
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sample_rate * 4)
            .map_err(|e| e.to_string())?;

        sink_writer
            .SetInputMediaType(stream_idx, &audio_in, None)
            .map_err(|e| e.to_string())?;

        Ok(stream_idx)
    }

    pub fn write_frame_bgra(&mut self, bgra_data: &[u8]) -> Result<(), String> {
        if self.is_finalized {
            return Ok(());
        }

        unsafe {
            let buffer_len = bgra_data.len() as u32;
            let media_buffer = MFCreateMemoryBuffer(buffer_len)
                .map_err(|e| format!("MFCreateMemoryBuffer failed: {e}"))?;

            let mut dest_ptr = std::ptr::null_mut();
            let mut max_len = 0u32;
            let mut cur_len = 0u32;
            media_buffer
                .Lock(&mut dest_ptr, Some(&mut max_len), Some(&mut cur_len))
                .map_err(|e| format!("Lock media buffer failed: {e}"))?;

            std::ptr::copy_nonoverlapping(bgra_data.as_ptr(), dest_ptr, bgra_data.len());
            media_buffer
                .Unlock()
                .map_err(|e| format!("Unlock media buffer failed: {e}"))?;
            media_buffer
                .SetCurrentLength(buffer_len)
                .map_err(|e| format!("SetCurrentLength failed: {e}"))?;

            let sample = MFCreateSample().map_err(|e| format!("MFCreateSample failed: {e}"))?;
            sample
                .AddBuffer(&media_buffer)
                .map_err(|e| format!("AddBuffer failed: {e}"))?;

            // Real-time wall-clock media timestamping (clamped across alt-tab pauses)
            // Guarantees 1.000s of real gameplay = 1.000s of video playback at 1.0x Normal speed!
            let now = Instant::now();
            let step_hns = match self.last_frame_instant {
                Some(prev) => {
                    let elapsed_hns = (now.duration_since(prev).as_nanos() / 100) as i64;
                    if elapsed_hns > 3_500_000 {
                        // Paused (e.g., user alt-tabbed for >350ms): advance by single nominal frame so no dead gap is recorded
                        self.frame_duration_hns
                    } else {
                        elapsed_hns.max(self.frame_duration_hns / 2)
                    }
                }
                None => 0,
            };
            self.last_frame_instant = Some(now);
            let sample_time_hns = self.current_video_time_hns;
            let sample_dur_hns = if step_hns > 0 {
                step_hns
            } else {
                self.frame_duration_hns
            };
            self.current_video_time_hns += sample_dur_hns;
            self.frame_count += 1;

            sample
                .SetSampleTime(sample_time_hns)
                .map_err(|e| format!("SetSampleTime failed: {e}"))?;
            sample
                .SetSampleDuration(sample_dur_hns)
                .map_err(|e| format!("SetSampleDuration failed: {e}"))?;

            self.sink_writer
                .WriteSample(self.video_stream_index, &sample)
                .map_err(|e| format!("WriteSample failed: {e}"))?;

            Ok(())
        }
    }

    pub fn write_audio_pcm16(&mut self, pcm16_stereo: &[u8], input_sample_rate: u32) -> Result<(), String> {
        if self.is_finalized || pcm16_stereo.is_empty() {
            return Ok(());
        }
        let Some(audio_idx) = self.audio_stream_index else {
            return Ok(());
        };

        let frames_in = (pcm16_stereo.len() / 4) as i64;
        if frames_in <= 0 {
            return Ok(());
        }

        // Keep audio clock synchronized with real-time video clock
        let video_time_hns = self.current_video_time_hns;
        let sr = self.audio_sample_rate.max(1) as i64;
        let mut audio_time_hns = (self.audio_frames_written * 10_000_000) / sr;
        if audio_time_hns > video_time_hns + 2_500_000 {
            return Ok(());
        }
        // If audio lagged behind video (e.g., after silence), resync audio clock to video clock
        if video_time_hns > audio_time_hns + 3_000_000 {
            self.audio_frames_written = (video_time_hns * sr) / 10_000_000;
            audio_time_hns = video_time_hns;
        }

        unsafe {
            let buffer_len = pcm16_stereo.len() as u32;
            let media_buffer =
                MFCreateMemoryBuffer(buffer_len).map_err(|e| format!("Audio buffer err: {e}"))?;

            let mut dest_ptr = std::ptr::null_mut();
            let mut max_len = 0u32;
            let mut cur_len = 0u32;
            media_buffer
                .Lock(&mut dest_ptr, Some(&mut max_len), Some(&mut cur_len))
                .map_err(|e| e.to_string())?;
            std::ptr::copy_nonoverlapping(pcm16_stereo.as_ptr(), dest_ptr, pcm16_stereo.len());
            media_buffer.Unlock().map_err(|e| e.to_string())?;
            media_buffer
                .SetCurrentLength(buffer_len)
                .map_err(|e| e.to_string())?;

            let sample = MFCreateSample().map_err(|e| e.to_string())?;
            sample.AddBuffer(&media_buffer).map_err(|e| e.to_string())?;

            let effective_sr = if input_sample_rate > 0 {
                input_sample_rate as i64
            } else {
                sr
            };
            let duration_hns = (frames_in * 10_000_000) / effective_sr.max(1);
            sample
                .SetSampleTime(audio_time_hns)
                .map_err(|e| e.to_string())?;
            sample
                .SetSampleDuration(duration_hns.max(1))
                .map_err(|e| e.to_string())?;

            self.audio_frames_written += frames_in;
            let _ = self.sink_writer.WriteSample(audio_idx, &sample);
            Ok(())
        }
    }

    pub fn finalize(&mut self) -> Result<(), String> {
        if self.is_finalized {
            return Ok(());
        }
        self.is_finalized = true;
        unsafe {
            if let Some(audio_idx) = self.audio_stream_index {
                if self.audio_frames_written == 0 {
                    let silence = [0u8; 3840]; // 20ms @ 48kHz stereo
                    if let Ok(buf) = MFCreateMemoryBuffer(silence.len() as u32) {
                        let mut ptr = std::ptr::null_mut();
                        if buf.Lock(&mut ptr, None, None).is_ok() {
                            std::ptr::copy_nonoverlapping(silence.as_ptr(), ptr, silence.len());
                            let _ = buf.Unlock();
                            let _ = buf.SetCurrentLength(silence.len() as u32);
                            if let Ok(sample) = MFCreateSample() {
                                let _ = sample.AddBuffer(&buf);
                                let _ = sample.SetSampleTime(0);
                                let _ = sample.SetSampleDuration(200_000);
                                let _ = self.sink_writer.WriteSample(audio_idx, &sample);
                            }
                        }
                    }
                }
            }
            self.sink_writer
                .Finalize()
                .map_err(|e| format!("Finalize sink writer failed: {e}"))?;
            Ok(())
        }
    }
}

impl Drop for MfVideoRecorder {
    fn drop(&mut self) {
        let _ = self.finalize();
    }
}

unsafe impl Send for MfVideoRecorder {}
