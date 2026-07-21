fn main() {
    #[cfg(target_os = "windows")]
    {
        let icon = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"))
            .join("codex-meter.ico");
        std::fs::write(&icon, windows_icon()).expect("write generated Windows icon");
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(icon));
        tauri_build::try_build(attributes).expect("build Tauri resources");
    }

    #[cfg(not(target_os = "windows"))]
    tauri_build::build();
}

#[cfg(target_os = "windows")]
fn windows_icon() -> Vec<u8> {
    const SIZE: usize = 32;
    const PIXELS: usize = SIZE * SIZE * 4;
    const MASK: usize = SIZE * 4;
    let image_bytes = 40 + PIXELS + MASK;
    let mut ico = Vec::with_capacity(22 + image_bytes);

    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.extend_from_slice(&[SIZE as u8, SIZE as u8, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&(image_bytes as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&40u32.to_le_bytes());
    ico.extend_from_slice(&(SIZE as i32).to_le_bytes());
    ico.extend_from_slice(&((SIZE * 2) as i32).to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&0u32.to_le_bytes());
    ico.extend_from_slice(&(PIXELS as u32).to_le_bytes());
    ico.extend_from_slice(&[0; 16]);

    for y in (0..SIZE).rev() {
        for x in 0..SIZE {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let radius = (dx * dx + dy * dy).sqrt();
            if (10.5..=14.0).contains(&radius) {
                ico.extend_from_slice(&[220, 215, 57, 255]);
            } else {
                ico.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    ico.extend(std::iter::repeat(0u8).take(MASK));
    ico
}
