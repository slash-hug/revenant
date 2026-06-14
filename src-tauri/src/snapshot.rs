//! Native macOS WKWebView snapshot.
//!
//! Captures the *real* rendered web content — fonts and all — straight from
//! WKWebView via `takeSnapshotWithConfiguration:completionHandler:`, returning
//! a PNG data URL.
//!
//! Why this exists: the open transition (`Suminagashi.svelte`) needs a bitmap of
//! the freshly-opened document to feed the GPU ink reveal. On macOS the obvious
//! route — html-to-image, which rasterises the DOM through an SVG `<foreignObject>`
//! drawn to a canvas — silently drops `@font-face` fonts, because WebKit does not
//! render custom fonts inside that path. The editor's JetBrains Mono then "snaps"
//! when the transition hands off to the live DOM. Chromium (and therefore Windows'
//! WebView2) renders foreignObject fonts correctly, so html-to-image stays the
//! cross-platform fallback; this native path is macOS-only.
//!
//! The whole module compiles only on macOS.

use crate::ipc::{IpcError, IpcResult};
use tauri::WebviewWindow;

/// Capture the current web content as a `data:image/png;base64,...` URL.
///
/// `takeSnapshot` is asynchronous: it returns immediately and invokes a
/// completion block on the main thread once the bitmap is ready. We bridge that
/// back to the async command with a channel, waiting on a blocking thread so the
/// async executor is never stalled.
pub async fn capture_png_data_url(window: WebviewWindow) -> IpcResult<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    window
        .with_webview(move |webview| {
            use block2::RcBlock;
            use objc2_app_kit::NSImage;
            use objc2_foundation::NSError;
            use objc2_web_kit::WKWebView;

            // On macOS, `PlatformWebview::inner()` is the WKWebView pointer (this
            // is the cast shown in Tauri's own `with_webview` docs). The webview
            // outlives this synchronous closure, which runs on the main thread.
            let wk: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };

            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                if image.is_null() {
                    let _ = tx.send(Err(if error.is_null() {
                        "takeSnapshot returned a nil image".to_string()
                    } else {
                        "takeSnapshot failed".to_string()
                    }));
                    return;
                }
                // SAFETY: `image` is a valid, non-null NSImage owned by the
                // callee for the duration of this completion block.
                let result = unsafe { png_from_nsimage(&*image) };
                let _ = tx.send(result);
            });

            // A nil configuration snapshots the webview's current visible bounds.
            // SAFETY: standard WKWebView API; the block is copied by the callee
            // and invoked once on the main thread.
            unsafe {
                wk.takeSnapshotWithConfiguration_completionHandler(None, &handler);
            }
        })
        .map_err(|e| IpcError {
            code: "SNAPSHOT_ERROR".into(),
            message: format!("with_webview failed: {e}"),
        })?;

    let png = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
    })
    .await
    .map_err(|e| IpcError {
        code: "SNAPSHOT_ERROR".into(),
        message: format!("snapshot task join error: {e}"),
    })?
    .map_err(|_| IpcError {
        code: "SNAPSHOT_TIMEOUT".into(),
        message: "webview snapshot timed out".into(),
    })?
    .map_err(|m| IpcError {
        code: "SNAPSHOT_ERROR".into(),
        message: m,
    })?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Encode an `NSImage` (as returned by `takeSnapshot`) to PNG bytes:
/// TIFF representation → `NSBitmapImageRep` → PNG.
///
/// # Safety
/// `image` must be a valid `NSImage`.
unsafe fn png_from_nsimage(image: &objc2_app_kit::NSImage) -> Result<Vec<u8>, String> {
    use objc2::runtime::AnyObject;
    use objc2::AnyThread; // brings `NSBitmapImageRep::alloc()` into scope
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;

    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "NSImage has no TIFF representation".to_string())?;

    let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
        .ok_or_else(|| "could not build NSBitmapImageRep from snapshot".to_string())?;

    let props: objc2::rc::Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
        NSDictionary::new();

    let png = rep
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
        .ok_or_else(|| "PNG encoding of snapshot failed".to_string())?;

    Ok(png.to_vec())
}
