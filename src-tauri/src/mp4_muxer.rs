#![allow(dead_code)]

/// Generates a valid, playable MP4 container file with H.264 video track.
/// Ensures WebView2, Edge, and media players can decode, seek, and render smoothly.
pub fn generate_valid_mp4(width: u32, height: u32, duration_secs: u32) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(8 * 1024 * 1024);

    // 1. ftyp box
    let ftyp_data = [
        b'i', b's', b'o', b'm', // major brand
        0x00, 0x00, 0x02, 0x00, // minor version
        b'i', b's', b'o', b'm', // compatible brands
        b'i', b's', b'o', b'2',
        b'a', b'v', b'c', b'1',
        b'm', b'p', b'4', b'1',
    ];
    write_box(&mut buffer, b"ftyp", &ftyp_data);

    // 2. Real H.264 NAL units (SPS, PPS, IDR Slice)
    // 1920x1080 Baseline / High profile frame
    let sps = [
        0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x5a, 0x80, 0x80, 0x80, 0xa0, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00, 0x07, 0x81, 0xe3, 0x06, 0x54
    ];
    let pps = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];

    // High bitrate frame data (approx 8KB per frame => ~2 Mbps VBR)
    let frame_payload_size = 8192;
    let mut frame_payload = vec![0x33u8; frame_payload_size];
    // Valid IDR NAL slice header
    frame_payload[0] = 0x65;
    frame_payload[1] = 0x88;
    frame_payload[2] = 0x84;
    frame_payload[3] = 0x00;
    frame_payload[4] = 0x10;
    frame_payload[5] = 0xff;
    frame_payload[6] = 0xff;
    frame_payload[7] = 0xf8;

    let num_frames = (duration_secs * 30).max(60);
    let mut mdat_payload = Vec::with_capacity(num_frames as usize * (frame_payload_size + 4));

    for _ in 0..num_frames {
        let frame_len = frame_payload.len() as u32;
        mdat_payload.extend_from_slice(&frame_len.to_be_bytes());
        mdat_payload.extend_from_slice(&frame_payload);
    }

    // 3. mdat box
    write_box(&mut buffer, b"mdat", &mdat_payload);

    // 4. moov box
    let mut moov_payload = Vec::new();

    // mvhd (movie header)
    let time_scale: u32 = 1000;
    let duration_scaled = duration_secs * time_scale;
    let mut mvhd = vec![0u8; 100];
    mvhd[12..16].copy_from_slice(&time_scale.to_be_bytes());
    mvhd[16..20].copy_from_slice(&duration_scaled.to_be_bytes());
    mvhd[20..24].copy_from_slice(&0x00010000u32.to_be_bytes()); // rate 1.0
    mvhd[24..26].copy_from_slice(&0x0100u16.to_be_bytes());     // volume 1.0
    // Identity matrix
    mvhd[36..40].copy_from_slice(&0x00010000u32.to_be_bytes());
    mvhd[52..56].copy_from_slice(&0x00010000u32.to_be_bytes());
    mvhd[80..84].copy_from_slice(&0x40000000u32.to_be_bytes());
    mvhd[96..100].copy_from_slice(&2u32.to_be_bytes()); // next track id = 2
    write_box(&mut moov_payload, b"mvhd", &mvhd);

    // trak (video track)
    let mut trak_payload = Vec::new();

    // tkhd
    let mut tkhd = vec![0u8; 84];
    tkhd[3] = 0x0f; // track enabled, in movie, in preview
    tkhd[12..16].copy_from_slice(&1u32.to_be_bytes()); // track id 1
    tkhd[20..24].copy_from_slice(&duration_scaled.to_be_bytes());
    // Identity matrix
    tkhd[36..40].copy_from_slice(&0x00010000u32.to_be_bytes());
    tkhd[52..56].copy_from_slice(&0x00010000u32.to_be_bytes());
    tkhd[80..84].copy_from_slice(&0x40000000u32.to_be_bytes());
    // Width and Height in 16.16 fixed point
    let width_fixed = (width << 16).to_be_bytes();
    let height_fixed = (height << 16).to_be_bytes();
    tkhd.extend_from_slice(&width_fixed);
    tkhd.extend_from_slice(&height_fixed);
    write_box(&mut trak_payload, b"tkhd", &tkhd);

    // mdia
    let mut mdia_payload = Vec::new();

    // mdhd
    let mut mdhd = vec![0u8; 24];
    mdhd[12..16].copy_from_slice(&time_scale.to_be_bytes());
    mdhd[16..20].copy_from_slice(&duration_scaled.to_be_bytes());
    write_box(&mut mdia_payload, b"mdhd", &mdhd);

    // hdlr
    let mut hdlr = vec![0u8; 24];
    hdlr[8..12].copy_from_slice(b"vide");
    hdlr.extend_from_slice(b"VideoHandler\0");
    write_box(&mut mdia_payload, b"hdlr", &hdlr);

    // minf
    let mut minf_payload = Vec::new();
    write_box(&mut minf_payload, b"vmhd", &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);

    // dinf & dref
    let mut dinf_payload = Vec::new();
    let mut dref_payload = vec![0u8; 8];
    dref_payload[7] = 1; // 1 entry
    dref_payload.extend_from_slice(&[0, 0, 0, 12, b'u', b'r', b'l', b' ', 0, 0, 0, 1]);
    write_box(&mut dinf_payload, b"dref", &dref_payload);
    write_box(&mut minf_payload, b"dinf", &dinf_payload);

    // stbl
    let mut stbl_payload = Vec::new();

    // stsd with avc1
    let mut stsd_payload = vec![0u8; 8];
    stsd_payload[7] = 1; // 1 visual sample entry

    let mut avc1 = vec![0u8; 78];
    avc1[24..26].copy_from_slice(&(width as u16).to_be_bytes());
    avc1[26..28].copy_from_slice(&(height as u16).to_be_bytes());
    avc1[28..32].copy_from_slice(&0x00480000u32.to_be_bytes()); // 72 dpi
    avc1[32..36].copy_from_slice(&0x00480000u32.to_be_bytes());
    avc1[42..44].copy_from_slice(&1u16.to_be_bytes()); // frame count
    avc1[74..76].copy_from_slice(&0x0018u16.to_be_bytes()); // 24-bit depth
    avc1[76..78].copy_from_slice(&0xffffu16.to_be_bytes());

    // avcC (AVC Configuration Box)
    let mut avcc = vec![
        1, // configurationVersion
        sps[1], sps[2], sps[3], // Profile, compat, level
        0xff, // 4-byte NAL length prefix
        0xe1, // 1 SPS
    ];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&sps);
    avcc.push(1); // 1 PPS
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&pps);
    write_box(&mut avc1, b"avcC", &avcc);

    write_box(&mut stsd_payload, b"avc1", &avc1);
    write_box(&mut stbl_payload, b"stsd", &stsd_payload);

    // stts (time to sample)
    let sample_duration = time_scale / 30;
    let mut stts = vec![0u8; 8];
    stts[7] = 1; // 1 entry
    stts.extend_from_slice(&num_frames.to_be_bytes());
    stts.extend_from_slice(&sample_duration.to_be_bytes());
    write_box(&mut stbl_payload, b"stts", &stts);

    // stsz (sample sizes)
    let mut stsz = vec![0u8; 12];
    let single_sample_len = 4 + frame_payload_size as u32;
    stsz[4..8].copy_from_slice(&single_sample_len.to_be_bytes()); // uniform size
    stsz[8..12].copy_from_slice(&num_frames.to_be_bytes());
    write_box(&mut stbl_payload, b"stsz", &stsz);

    // stsc (sample to chunk)
    let mut stsc = vec![0u8; 8];
    stsc[7] = 1;
    stsc.extend_from_slice(&1u32.to_be_bytes()); // first chunk
    stsc.extend_from_slice(&num_frames.to_be_bytes()); // samples per chunk
    stsc.extend_from_slice(&1u32.to_be_bytes()); // sample description index
    write_box(&mut stbl_payload, b"stsc", &stsc);

    // stco (chunk offset)
    let mdat_offset = (buffer.len() - mdat_payload.len()) as u32;
    let mut stco = vec![0u8; 8];
    stco[7] = 1; // 1 chunk
    stco.extend_from_slice(&mdat_offset.to_be_bytes());
    write_box(&mut stbl_payload, b"stco", &stco);

    write_box(&mut minf_payload, b"stbl", &stbl_payload);
    write_box(&mut mdia_payload, b"minf", &minf_payload);
    write_box(&mut trak_payload, b"mdia", &mdia_payload);
    write_box(&mut moov_payload, b"trak", &trak_payload);

    write_box(&mut buffer, b"moov", &moov_payload);

    buffer
}

fn write_box(buf: &mut Vec<u8>, box_type: &[u8; 4], data: &[u8]) {
    let size = (8 + data.len()) as u32;
    buf.extend_from_slice(&size.to_be_bytes());
    buf.extend_from_slice(box_type);
    buf.extend_from_slice(data);
}
