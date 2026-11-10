use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct ShareData {
    pub local_url: String,
    pub lan_url: String,
    pub stream_url: String,
    pub access: String, // "anyone" or "restricted"
    pub file_name: String,
    pub file_path: String,
    pub custom_domain_url: String,
    pub encrypted_token: String,
    pub encryption_key_hex: String,
    pub stackryze_domain: String,
}

#[derive(Clone)]
pub struct WebShareServer {
    pub port: u16,
    pub lan_ip: String,
    // clip_key -> (file_path, access_mode)
    pub registry: Arc<RwLock<HashMap<String, (PathBuf, String)>>>,
}

impl WebShareServer {
    pub fn new() -> Self {
        let lan_ip = Self::detect_lan_ip();
        Self {
            port: 4545,
            lan_ip,
            registry: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn detect_lan_ip() -> String {
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    return addr.ip().to_string();
                }
            }
        }
        "127.0.0.1".to_string()
    }

    pub fn register_clip(&self, file_path: &Path, default_access: &str) -> String {
        let stem = file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "clip".to_string());
        
        let mut reg = self.registry.write().unwrap();
        if reg.contains_key(&stem) {
            return stem;
        }
        reg.insert(stem.clone(), (file_path.to_path_buf(), default_access.to_string()));
        stem
    }

    pub fn set_access(&self, clip_key: &str, access: &str) {
        let mut reg = self.registry.write().unwrap();
        if let Some(entry) = reg.get_mut(clip_key) {
            entry.1 = access.to_string();
        }
    }

    pub fn get_access(&self, clip_key: &str) -> String {
        let reg = self.registry.read().unwrap();
        reg.get(clip_key)
            .map(|(_, a)| a.clone())
            .unwrap_or_else(|| "anyone".to_string())
    }

    fn lookup_clip(&self, clip_key: &str) -> Option<(PathBuf, String)> {
        let reg = self.registry.read().unwrap();
        reg.get(clip_key).cloned()
    }

    pub fn start_background(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
            let listener = match TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(err) => {
                    eprintln!("[WebShareServer] Failed to bind {}: {:?}", addr, err);
                    return;
                }
            };
            println!("[WebShareServer] Running on http://localhost:{} and http://{}:{}", self.port, self.lan_ip, self.port);

            loop {
                match listener.accept().await {
                    Ok((stream, _peer)) => {
                        let server_ref = self.clone();
                        tokio::spawn(async move {
                            let _ = server_ref.handle_client(stream).await;
                        });
                    }
                    Err(_) => {
                        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                    }
                }
            }
        });
    }

    async fn handle_client(&self, mut stream: TcpStream) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut buffer = [0u8; 4096];
        let bytes_read = stream.read(&mut buffer).await?;
        if bytes_read == 0 {
            return Ok(());
        }

        let request_str = String::from_utf8_lossy(&buffer[..bytes_read]);
        let mut lines = request_str.lines();
        let request_line = match lines.next() {
            Some(l) => l,
            None => return Ok(()),
        };

        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("GET");
        let path = parts.next().unwrap_or("/");

        if method != "GET" && method != "HEAD" {
            let res = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(res.as_bytes()).await;
            return Ok(());
        }

        // Parse query params
        let (endpoint, query) = match path.split_once('?') {
            Some((ep, q)) => (ep, q),
            None => (path, ""),
        };

        let mut clip_key = String::new();
        let mut cdn_src = String::new();
        for param in query.split('&') {
            if let Some((k, v)) = param.split_once('=') {
                if k == "clip" {
                    clip_key = v.to_string();
                } else if k == "v" || k == "cdn" {
                    cdn_src = v.to_string();
                }
            }
        }

        // Extract Range header if present
        let mut range_header = None;
        for line in lines {
            if line.to_ascii_lowercase().starts_with("range:") {
                if let Some((_, val)) = line.split_once(':') {
                    range_header = Some(val.trim().to_string());
                }
            }
        }

        match endpoint {
            "/play" | "/watch" => {
                self.handle_play_page(&mut stream, &clip_key, &cdn_src).await?;
            }
            "/stream" => {
                self.handle_stream(&mut stream, &clip_key, range_header.as_deref()).await?;
            }
            _ => {
                let body = "Not Found";
                let res = format!(
                    "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(res.as_bytes()).await;
            }
        }

        Ok(())
    }

    async fn handle_play_page(&self, stream: &mut TcpStream, clip_key: &str, cdn_src: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (display_name, video_src) = if !cdn_src.is_empty() {
            let name = if !clip_key.is_empty() {
                clip_key.replace('_', " ")
            } else {
                "Gameplay Highlight".to_string()
            };
            (name, cdn_src.to_string())
        } else {
            let (file_path, access) = match self.lookup_clip(clip_key) {
                Some((p, a)) => (p, a),
                None => {
                    let body = r#"<!DOCTYPE html><html><body style="background:#0A0B0E;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><h1>Clip Not Found</h1></body></html>"#;
                    let res = format!("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
                    stream.write_all(res.as_bytes()).await?;
                    return Ok(());
                }
            };

            if access == "restricted" {
                let body = r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eclipse - Link Restricted</title>
  <style>
    body { background: #07080B; color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #0F1117; border: 1px solid #2A2D34; border-radius: 16px; padding: 40px; text-align: center; max-width: 440px; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
    .lock-icon { font-size: 48px; margin-bottom: 16px; display: inline-block; }
    h1 { margin: 0 0 10px 0; font-size: 22px; color: #F87171; font-weight: 800; }
    p { color: #94A3B8; font-size: 14px; line-height: 1.5; margin: 0; }
    .badge { display: inline-block; margin-top: 24px; padding: 6px 14px; border-radius: 999px; background: #1E222A; border: 1px solid #334155; font-size: 11px; font-weight: 700; color: #CBD5E1; letter-spacing: 0.05em; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="card">
    <div class="lock-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#F87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <h1>Access Restricted</h1>
    <p>This highlight clip is currently marked as private. The creator has restricted public viewing for this link.</p>
    <div class="badge">Protected via Eclipse Pro</div>
  </div>
</body>
</html>"##;
                let res = format!("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
                stream.write_all(res.as_bytes()).await?;
                return Ok(());
            }

            let name = file_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Gameplay Highlight".to_string())
                .replace('_', " ");
            (name, format!("/stream?clip={}", clip_key))
        };

        let body = format!(r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eclipse - {display_name}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background-color: #07080B;
      color: #FFFFFF;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow-x: hidden;
    }}
    .container {{
      width: 100%;
      max-width: 1060px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }}
    .header {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 4px;
    }}
    .brand {{
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .brand-title {{
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #FFFFFF;
    }}
    .brand-pill {{
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      font-weight: 900;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(147, 51, 234, 0.25);
      color: #C084FC;
      border: 1px solid rgba(147, 51, 234, 0.45);
      text-transform: uppercase;
    }}
    .video-wrapper {{
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #000000;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #2A2D34;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 30px rgba(124, 58, 237, 0.2);
    }}
    video {{
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }}
    .meta-bar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #0F1117;
      border: 1px solid #2A2D34;
      border-radius: 12px;
      padding: 12px 18px;
    }}
    .clip-title {{
      font-size: 14px;
      font-weight: 700;
      color: #F1F5F9;
      display: flex;
      align-items: center;
      gap: 8px;
    }}
    .badge-live {{
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #00D48F;
      box-shadow: 0 0 8px #00D48F;
    }}
    .footer-note {{
      text-align: center;
      font-size: 11px;
      color: #64748B;
      font-family: 'JetBrains Mono', monospace;
      margin-top: 8px;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">
        <svg class="brand-logo" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#A855F7" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.2 8.8 22 12 15.2 15.2 12 22 8.8 15.2 2 12 8.8 8.8 12 2"></polygon>
          <circle cx="12" cy="12" r="2.5" fill="#A855F7"></circle>
        </svg>
        <span class="brand-title">ECLIPSE</span>
        <span class="brand-pill">PLAYER</span>
      </div>
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #94A3B8;">
        Shared Highlight
      </div>
    </div>

    <div class="video-wrapper">
      <video controls autoplay playsinline src="{video_src}" preload="auto"></video>
    </div>

    <div class="meta-bar">
      <div class="clip-title">
        <span class="badge-live"></span>
        <span>{display_name}</span>
      </div>
    </div>
  </div>
</body>
</html>"##);

        let res = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(res.as_bytes()).await?;
        Ok(())
    }

    async fn handle_stream(
        &self,
        stream: &mut TcpStream,
        clip_key: &str,
        range_header: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (file_path, access) = match self.lookup_clip(clip_key) {
            Some((p, a)) => (p, a),
            None => {
                let res = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                stream.write_all(res.as_bytes()).await?;
                return Ok(());
            }
        };

        if access == "restricted" {
            let res = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
            stream.write_all(res.as_bytes()).await?;
            return Ok(());
        }

        let mut file = match tokio::fs::File::open(&file_path).await {
            Ok(f) => f,
            Err(_) => {
                let res = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                stream.write_all(res.as_bytes()).await?;
                return Ok(());
            }
        };

        let file_len = file.metadata().await?.len();
        if file_len == 0 {
            let res = "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 0\r\n\r\n";
            stream.write_all(res.as_bytes()).await?;
            return Ok(());
        }

        // Support HTTP Range requests
        if let Some(range) = range_header {
            if let Some(spec) = range.strip_prefix("bytes=") {
                let parts: Vec<&str> = spec.split('-').collect();
                let start: u64 = parts[0].parse().unwrap_or(0);
                let end: u64 = if parts.len() > 1 && !parts[1].is_empty() {
                    parts[1].parse().unwrap_or(file_len - 1)
                } else {
                    file_len - 1
                };

                let end = end.min(file_len - 1);
                if start <= end {
                    let content_length = end - start + 1;
                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: keep-alive\r\n\r\n",
                        start, end, file_len, content_length
                    );
                    stream.write_all(header.as_bytes()).await?;

                    file.seek(std::io::SeekFrom::Start(start)).await?;
                    let mut reader = tokio::io::AsyncReadExt::take(file, content_length);
                    tokio::io::copy(&mut reader, stream).await?;
                    return Ok(());
                }
            }
        }

        // Full file stream
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: keep-alive\r\n\r\n",
            file_len
        );
        stream.write_all(header.as_bytes()).await?;
        tokio::io::copy(&mut file, stream).await?;

        Ok(())
    }
}
