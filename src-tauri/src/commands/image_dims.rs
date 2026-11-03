use std::path::Path;

use crate::core::image_dims;

/// `[width, height]` for each path, in order; `null` for a file that is not a readable PNG, GIF,
/// BMP, WebP, JPEG, TIFF, HEIC, HEIF or AVIF. Header reads only, so a long list is cheap. The
/// Dimensions column asks for the images it is about to show.
#[tauri::command(async)]
pub fn image_dimensions(paths: Vec<String>) -> Vec<Option<[u32; 2]>> {
    paths
        .iter()
        .map(|p| image_dims::image_dimensions(Path::new(p)).map(|(w, h)| [w, h]))
        .collect()
}
