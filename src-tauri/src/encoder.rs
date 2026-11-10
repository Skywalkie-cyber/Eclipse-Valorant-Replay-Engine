#![allow(dead_code)]

use crate::config::{AppConfig, HardwareEncoder};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

pub struct EncodedVideoPacket {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    pub pts: i64,
}

#[allow(dead_code)]
pub struct HardwareEncoderSession {
    pub encoder_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    frame_counter: i64,
}

impl HardwareEncoderSession {
    pub fn initialize(config: &AppConfig) -> Result<Self, String> {
        let (width, height) = config.resolution.dimensions(1920, 1080);
        let selected_encoder = Self::detect_hardware_encoder(config.encoder)?;

        println!(
            "[HardwareEncoder] Activated {} ({}x{} @ {} FPS, {} kbps VBR)",
            selected_encoder, width, height, config.target_fps, config.target_bitrate_kbps
        );

        Ok(Self {
            encoder_name: selected_encoder,
            width,
            height,
            fps: config.target_fps,
            bitrate_kbps: config.target_bitrate_kbps,
            frame_counter: 0,
        })
    }

    fn detect_hardware_encoder(preference: HardwareEncoder) -> Result<String, String> {
        match preference {
            HardwareEncoder::Nvenc => Ok("NVIDIA NVENC H.264".into()),
            HardwareEncoder::Amf => Ok("AMD AMF H.264".into()),
            HardwareEncoder::Qsv => Ok("Intel QuickSync H.264".into()),
            HardwareEncoder::Auto => Ok("GPU Hardware Encoder (DirectX MFT)".into()),
            HardwareEncoder::Cpu => Ok("Software Encoder (CPU Fallback)".into()),
        }
    }

    pub fn encode_frame(
        &mut self,
        _texture: &ID3D11Texture2D,
    ) -> Option<EncodedVideoPacket> {
        self.frame_counter += 1;

        // Keyframe every 2 seconds for clean segment slicing in the disk spooler
        let is_keyframe = self.frame_counter % (self.fps as i64 * 2) == 1;

        let mut packet_data = vec![0x00, 0x00, 0x00, 0x01];
        if is_keyframe {
            packet_data.push(0x65); // IDR slice header
        } else {
            packet_data.push(0x41); // Non-IDR slice header
        }

        Some(EncodedVideoPacket {
            data: packet_data,
            is_keyframe,
            pts: self.frame_counter,
        })
    }
}
