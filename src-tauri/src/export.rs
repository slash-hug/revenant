//! High-fidelity PDF and HTML export commands.
//!
//! All three commands live here (WS-A owns this module alongside the IPC
//! surface that gates it).  Path validation is defensive and explicit:
//!
//! - `export_html` / `export_pdf` — user-chosen "Save as" paths.  No vault
//!   confinement (a Save-As dialog is an explicit user intent), BUT we
//!   validate: absolute path, correct extension (case-insensitive), and
//!   `has_parent_traversal` on any derived component.
//!
//! - `read_file_bytes` — reads a resource file (e.g., an image) referenced
//!   from a document.  Confined to the doc's parent directory (all
//!   subdirectories included via `starts_with`), with a `has_parent_traversal`
//!   pre-guard so that dot-dot paths don't bypass the lexical confinement
//!   check.
//!
//! PDF export on macOS uses `WKWebView.createPDFWithConfiguration_completionHandler`
//! on a hidden off-screen WKWebView.  The webview is torn down in all paths
//! (success / timeout / panic).  On non-macOS platforms `export_pdf` returns
//! `PDF_EXPORT_UNSUPPORTED`.

use crate::ipc::{IpcError, IpcResult};
use std::path::Path;

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

pub(crate) fn validate_export_path(path: &Path, allowed_exts: &[&str]) -> IpcResult<()> {
    if !path.is_absolute() {
        return Err(IpcError {
            code: "INVALID_PATH".into(),
            message: format!(
                "export path '{}' must be absolute",
                path.display()
            ),
        });
    }

    if crate::paths::has_parent_traversal(path) {
        return Err(IpcError {
            code: "INVALID_PATH".into(),
            message: format!(
                "export path '{}' contains a parent-directory traversal component",
                path.display()
            ),
        });
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let ext_lower = ext.to_ascii_lowercase();
    if !allowed_exts.iter().any(|a| ext_lower == *a) {
        let expected = allowed_exts
            .iter()
            .map(|e| format!(".{e}"))
            .collect::<Vec<_>>()
            .join(" or ");
        return Err(IpcError {
            code: "INVALID_PATH".into(),
            message: format!(
                "export path '{}' has extension '.{ext}' but expected {expected} (case-insensitive)",
                path.display()
            ),
        });
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// A5 — export_html
// ---------------------------------------------------------------------------

/// Write a pre-rendered HTML bundle to `out_path`.
///
/// `out_path` must be an absolute path with a `.html` / `.HTML` extension and
/// no parent-directory traversal.  `html` is the complete self-contained HTML
/// document string produced by the frontend's `buildExportDocument` helper.
///
/// Returns the written path string on success.
pub fn export_html(out_path: &Path, html: &str) -> IpcResult<String> {
    validate_export_path(out_path, &["html"])?;

    // Ensure the parent directory exists.
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| IpcError {
            code: "IO_ERROR".into(),
            message: format!("could not create export directory '{}': {e}", parent.display()),
        })?;
    }

    // Write through the shared atomic helper (unique temp sibling → fsync →
    // atomic rename) so a crash/kill mid-write can never truncate or empty a
    // pre-existing export at this path (issue #40 P1). Plain fs::write truncates
    // the target *before* writing the new bytes.
    crate::file_io::atomic_write_bytes(out_path, html.as_bytes()).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not write HTML to '{}': {e}", out_path.display()),
    })?;

    Ok(out_path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// A6 — export_pdf
// ---------------------------------------------------------------------------

/// Convert an HTML bundle to a PDF file written to `out_path`.
///
/// On macOS: creates a hidden off-screen `WKWebView`, loads the HTML bundle,
/// waits for load completion, calls `createPDFWithConfiguration`, writes the
/// resulting bytes to disk, then tears the webview down.
///
/// On Windows: drives a hidden off-screen WebView2 to navigate the bundle and
/// `ICoreWebView2_7::PrintToPdf` (see `export_pdf_windows`).
///
/// On other platforms: returns `PDF_EXPORT_UNSUPPORTED` immediately.
pub async fn export_pdf(out_path: std::path::PathBuf, html: String) -> IpcResult<String> {
    validate_export_path(&out_path, &["pdf"])?;

    #[cfg(target_os = "macos")]
    {
        export_pdf_macos(out_path, html).await
    }

    #[cfg(windows)]
    {
        export_pdf_windows(out_path, html).await
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (out_path, html);
        Err(IpcError {
            code: "PDF_EXPORT_UNSUPPORTED".into(),
            message: "Native PDF export is only available on macOS and Windows.".into(),
        })
    }
}

// ---------------------------------------------------------------------------
// macOS PDF implementation
// ---------------------------------------------------------------------------
//
// G1 SMOKE TEST GATE — mandatory before merging any change to this section:
//
//   Run `cargo tauri dev`, open a real .md file, and trigger "Export as PDF".
//   Verify: file is non-blank, fonts render, Mermaid diagrams appear, inline
//   images are present, review comments (if any) appear in light mode even
//   when the app is in dark mode, and no orphaned WKWebView process remains
//   in Activity Monitor after the dialog closes.
//
//   Unit tests cannot exercise this path (WKWebView requires a GUI run-loop
//   and a real macOS environment). CI green does NOT prove the binary exports
//   a valid PDF. The G1 gate must be performed by a human on macOS.

/// `WkSendPtr` is a `*mut std::ffi::c_void` wrapper that is `Send`.
///
/// We guarantee single ownership and never use the pointer concurrently:
/// it is created on the main thread, held by exactly one thread at a time
/// (the polling thread), and all ObjC calls on the pointer are routed back
/// to the main thread via GCD.
#[cfg(target_os = "macos")]
struct WkSendPtr(*mut std::ffi::c_void);
#[cfg(target_os = "macos")]
// SAFETY: We ensure the raw pointer is only dereferenced on the macOS main
// thread (where WKWebView is safe to use).  We only use it from this
// thread-local-dispatched GCD work — never concurrently.
unsafe impl Send for WkSendPtr {}

/// macOS PDF path: WKWebView → createPDF → bytes → file.
#[cfg(target_os = "macos")]
async fn export_pdf_macos(out_path: std::path::PathBuf, html: String) -> IpcResult<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    // Kick off the WKWebView work from the Tauri async context.
    // The actual ObjC calls happen on the macOS main thread via GCD.
    spawn_pdf_worker(html, tx);

    // Block a worker thread while waiting for the result so the async
    // executor is not stalled.
    let pdf_bytes = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(30))
    })
    .await
    .map_err(|e| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: format!("PDF task join error: {e}"),
    })?
    .map_err(|_| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: "PDF export timed out after 30 seconds.".into(),
    })?
    .map_err(|m| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: m,
    })?;

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| IpcError {
            code: "IO_ERROR".into(),
            message: format!("could not create export directory: {e}"),
        })?;
    }

    // Atomic write (temp sibling → fsync → rename): a crash mid-write must not
    // truncate a prior export at this path (issue #40 P1).
    crate::file_io::atomic_write_bytes(&out_path, &pdf_bytes).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not write PDF to '{}': {e}", out_path.display()),
    })?;

    Ok(out_path.to_string_lossy().into_owned())
}

/// Spawn the OS thread that drives the WKWebView lifecycle.
///
/// Step 1: Create WKWebView + load HTML (on the main thread, via dispatch_sync).
/// Step 2: Poll `isLoading` on this thread (safe as a BOOL poll).
/// Step 3: Request createPDF on the main thread (via dispatch_async; result
///         arrives via the callback which sends on `tx`).
#[cfg(target_os = "macos")]
fn spawn_pdf_worker(
    html: String,
    tx: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) {
    std::thread::spawn(move || {
        // ── Step 1: create WKWebView and load HTML synchronously on main thread.
        let wk_ptr = match create_wkwebview_sync(html) {
            Ok(p) => p,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };

        // ── Step 2: poll isLoading (bounded to 15 s).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if std::time::Instant::now() > deadline {
                let _ = tx.send(Err("WKWebView load timed out (15 s)".into()));
                release_wkwebview_async(wk_ptr);
                return;
            }
            // isLoading BOOL read — safe from any thread for polling.
            let loading = unsafe {
                use objc2_web_kit::WKWebView;
                (&*(wk_ptr.0 as *const WKWebView)).isLoading()
            };
            if !loading {
                break;
            }
        }

        // ── Step 3: call createPDF on the main thread.
        request_pdf_async(wk_ptr, tx);
    });
}

/// Create a WKWebView synchronously on the macOS main thread.
/// The `html` string is loaded via `loadHTMLString_baseURL(html, nil)`.
/// Returns `WkSendPtr` wrapping the retained raw pointer.
#[cfg(target_os = "macos")]
fn create_wkwebview_sync(html: String) -> Result<WkSendPtr, String> {
    use std::sync::{Arc, Mutex};

    let result: Arc<Mutex<Option<Result<WkSendPtr, String>>>> = Arc::new(Mutex::new(None));
    let result_clone = Arc::clone(&result);

    // SAFETY: dispatch_sync blocks until the closure completes.
    // The closure sets `result` and is the only writer.
    unsafe {
        gcd_dispatch_sync_main(move || {
            let outcome = create_wkwebview_on_main(html);
            *result_clone.lock().unwrap() = Some(outcome);
        });
    }

    // Bind the lock guard to a local so it lives long enough.
    let mut guard = result.lock().unwrap();
    guard
        .take()
        .unwrap_or_else(|| Err("dispatch_sync produced no result".into()))
}

/// Create the WKWebView.  MUST be called on the macOS main thread.
#[cfg(target_os = "macos")]
unsafe fn create_wkwebview_on_main(html: String) -> Result<WkSendPtr, String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSRect, NSPoint, NSSize, NSString};
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

    // SAFETY: this function is only called from within a GCD main-queue block.
    let mtm = unsafe { objc2::MainThreadMarker::new_unchecked() };

    // Lay the page out at US-Letter size (8.5×11in at 96 CSS px/in = 816×1056).
    // A tiny frame (e.g. 1×1) makes the body shrink-wrap to its min-content width
    // — every word wraps to its own line and code blocks clip — while @page still
    // sizes the PDF to Letter, producing a skinny column on a wide page. createPDF
    // captures the full content height regardless of the frame height.
    let frame = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize { width: 816.0, height: 1056.0 },
    };

    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let wk: Retained<WKWebView> = unsafe {
        WKWebView::initWithFrame_configuration(mtm.alloc::<WKWebView>(), frame, &config)
    };

    let ns_html = NSString::from_str(&html);
    unsafe { wk.loadHTMLString_baseURL(&ns_html, None) };

    // Convert to raw pointer; forget the Retained so it is not dropped.
    // The caller (or completion handler) is responsible for releasing.
    let raw = Retained::into_raw(wk) as *mut std::ffi::c_void;
    Ok(WkSendPtr(raw))
}

/// Dispatch `createPDFWithConfiguration` asynchronously on the main thread.
/// The completion handler sends bytes (or error) to `tx`, then releases the view.
#[cfg(target_os = "macos")]
fn request_pdf_async(
    wk: WkSendPtr,
    tx: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) {
    // `wk` (WkSendPtr: Send) and `tx` (Sender: Send) → the outer closure is Send.
    // The raw pointer is only extracted inside the GCD block (which runs on the
    // main thread) and inside the ObjC completion handler block (also main thread).
    unsafe {
        gcd_dispatch_async_main(move || {
            use block2::RcBlock;
            use objc2::rc::Retained;
            use objc2_foundation::{NSData, NSError};
            use objc2_web_kit::WKWebView;

            // SAFETY: we are on the main thread (inside a GCD main-queue block).
            let raw = wk.0;
            let wk_ref: &WKWebView = &*(raw as *const WKWebView);

            // The ObjC completion handler is not Send — it runs on the main
            // thread.  Wrap `raw` in a WkSendPtr so it can be moved into a
            // 'static closure (block2 requires 'static but not Send).
            // We convert back to a raw pointer immediately to avoid any accidental
            // Drop via WkSendPtr's field access.
            let wk_for_handler = WkSendPtr(raw);

            let handler = RcBlock::new(move |pdf_data: *mut NSData, error: *mut NSError| {
                if !pdf_data.is_null() {
                    let bytes = (&*pdf_data).to_vec();
                    let _ = tx.send(Ok(bytes));
                } else {
                    let msg = if !error.is_null() {
                        "createPDF returned an error".to_string()
                    } else {
                        "createPDF returned nil data".to_string()
                    };
                    let _ = tx.send(Err(msg));
                }
                // Release the WKWebView on the main thread (inside the callback).
                let raw_inner = wk_for_handler.0;
                let _ = Retained::from_raw(raw_inner as *mut WKWebView);
            });

            wk_ref.createPDFWithConfiguration_completionHandler(None, &handler);
        });
    }
}

/// Release a WKWebView on the main thread asynchronously.
/// Used when we need to tear down the view without generating a PDF (e.g., timeout).
#[cfg(target_os = "macos")]
fn release_wkwebview_async(wk: WkSendPtr) {
    // `wk` is WkSendPtr (Send), so this closure is Send.
    unsafe {
        gcd_dispatch_async_main(move || {
            use objc2::rc::Retained;
            use objc2_web_kit::WKWebView;
            let raw = wk.0;
            let _ = Retained::from_raw(raw as *mut WKWebView);
        });
    }
}

// ---------------------------------------------------------------------------
// GCD helpers (macOS only)
// ---------------------------------------------------------------------------

// We use the `dispatch2` crate for GCD access so we piggyback on its
// already-linked `libdispatch`.  The high-level API (`exec_async`, `exec_sync`)
// requires `Send`, but we need to dispatch closures containing ObjC types
// (WKWebView raw pointers, RcBlock) that are `!Send`.
//
// We therefore use the low-level `exec_async_f` / `exec_sync_f` methods which
// take a raw `*mut c_void` context — there is no `Send` requirement at that
// level.  We are responsible for ensuring that the closure is safe to execute
// on the main thread; we document this contract on each call site.

/// Submit a closure to the macOS main dispatch queue asynchronously.
///
/// # Safety
/// The closure `f` must be safe to execute on the main thread even if it is
/// not `Send`.  All closures passed here contain only ObjC main-thread types
/// (WKWebView pointers, RcBlock) that are safe on the main thread.
#[cfg(target_os = "macos")]
unsafe fn gcd_dispatch_async_main<F: FnOnce() + 'static>(f: F) {
    use dispatch2::DispatchQueue;
    use std::ffi::c_void;

    let boxed: Box<Box<dyn FnOnce()>> = Box::new(Box::new(f));
    let ptr = Box::into_raw(boxed) as *mut c_void;

    extern "C" fn trampoline(ctx: *mut c_void) {
        let f: Box<Box<dyn FnOnce()>> =
            unsafe { Box::from_raw(ctx as *mut Box<dyn FnOnce()>) };
        (*f)();
    }

    unsafe { DispatchQueue::main().exec_async_f(ptr, trampoline) };
}

/// Submit a closure to the macOS main dispatch queue and block until done.
/// MUST NOT be called from the main thread (would deadlock).
#[cfg(target_os = "macos")]
unsafe fn gcd_dispatch_sync_main<F: FnOnce() + Send + 'static>(f: F) {
    use dispatch2::DispatchQueue;
    use std::ffi::c_void;

    let boxed: Box<Box<dyn FnOnce() + Send + 'static>> = Box::new(Box::new(f));
    let ptr = Box::into_raw(boxed) as *mut c_void;

    extern "C" fn trampoline(ctx: *mut c_void) {
        let f: Box<Box<dyn FnOnce() + Send + 'static>> =
            unsafe { Box::from_raw(ctx as *mut Box<dyn FnOnce() + Send + 'static>) };
        (*f)();
    }

    unsafe { DispatchQueue::main().exec_sync_f(ptr, trampoline) };
}

// ---------------------------------------------------------------------------
// Windows PDF implementation
// ---------------------------------------------------------------------------
//
// G1 SMOKE TEST GATE (Windows) — mandatory before relying on this path:
//
//   Build, open a real .md file, trigger "Export as PDF". Verify the file is
//   non-blank, fonts render, Mermaid diagrams appear, inline images are present,
//   and review comments (if any) appear in light mode even when the app is dark.
//
//   WebView2 needs a GUI message loop and the runtime installed, so unit tests
//   cannot exercise this path. CI green proves it COMPILES on windows-latest, not
//   that it produces a valid PDF — the smoke gate must be run by a human.
//
// Approach: an off-screen WebView2 (separate from the live app webview, mirroring
// the macOS separate-WKWebView approach) navigates to the export bundle written to
// a temp file (a temp file avoids the data:-URI / CSP top-level-navigation limit),
// then ICoreWebView2_7::PrintToPdf writes the PDF. The whole COM lifecycle runs on
// a dedicated STA thread that owns the host window and pumps its message loop
// (webview2-com's wait_for_async_operation / wait_with_pump do the pumping).

/// Windows PDF path: off-screen WebView2 → PrintToPdf → bytes → atomic file write.
#[cfg(windows)]
async fn export_pdf_windows(out_path: std::path::PathBuf, html: String) -> IpcResult<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    // WebView2 requires a single-threaded-apartment thread that owns the window
    // and pumps messages. Run the entire COM lifecycle on a dedicated thread and
    // channel the PDF bytes back (mirrors the macOS spawn_pdf_worker structure).
    std::thread::spawn(move || {
        let _ = tx.send(windows_pdf_to_bytes(html));
    });

    let pdf_bytes = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(45))
    })
    .await
    .map_err(|e| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: format!("PDF task join error: {e}"),
    })?
    .map_err(|_| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: "PDF export timed out after 45 seconds.".into(),
    })?
    .map_err(|m| IpcError {
        code: "PDF_EXPORT_FAILED".into(),
        message: m,
    })?;

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| IpcError {
            code: "IO_ERROR".into(),
            message: format!("could not create export directory: {e}"),
        })?;
    }

    // Atomic write (temp sibling → fsync → rename), matching the macOS path and the
    // #40 crash-safety invariant.
    crate::file_io::atomic_write_bytes(&out_path, &pdf_bytes).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not write PDF to '{}': {e}", out_path.display()),
    })?;

    Ok(out_path.to_string_lossy().into_owned())
}

/// Stage the HTML bundle in a temp dir, render it to PDF via WebView2, read the
/// bytes back, and clean up. All `windows::core::Error`s are flattened to String
/// so they can cross the worker-thread channel.
#[cfg(windows)]
fn windows_pdf_to_bytes(html: String) -> Result<Vec<u8>, String> {
    // Unique temp workspace: bundle.html (navigation target), wv2/ (WebView2 user
    // data folder — must be writable, so never next to the exe), out.pdf (result).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut workspace = std::env::temp_dir();
    workspace.push(format!("revenant-pdf-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&workspace)
        .map_err(|e| format!("could not create PDF temp workspace: {e}"))?;

    let bundle = workspace.join("bundle.html");
    let user_data = workspace.join("wv2");
    let pdf_tmp = workspace.join("out.pdf");

    let result = (|| -> Result<Vec<u8>, String> {
        std::fs::write(&bundle, html.as_bytes())
            .map_err(|e| format!("could not write PDF bundle: {e}"))?;
        let nav_url = url::Url::from_file_path(&bundle)
            .map_err(|_| "could not build file URL for PDF bundle".to_string())?
            .to_string();

        // SAFETY: render_pdf_via_webview2 confines all COM/Win32 calls to this
        // thread, initializes and tears down COM, and destroys the host window.
        let ok = unsafe { render_pdf_via_webview2(&nav_url, &user_data, &pdf_tmp) }
            .map_err(|e| format!("WebView2 PDF render failed: {e}"))?;
        if !ok {
            return Err("WebView2 reported the print-to-PDF operation as unsuccessful".into());
        }
        std::fs::read(&pdf_tmp).map_err(|e| format!("could not read rendered PDF: {e}"))
    })();

    // Best-effort cleanup — WebView2 may briefly hold the user-data folder.
    let _ = std::fs::remove_dir_all(&workspace);
    result
}

/// Drive an off-screen WebView2 through environment → controller → navigate →
/// PrintToPdf, writing the PDF to `pdf_out`. Returns the `isSuccessful` flag.
///
/// # Safety
/// Must be called on a dedicated thread (it initializes COM as STA and pumps the
/// message loop). The host window and all COM objects live and die on this thread.
#[cfg(windows)]
unsafe fn render_pdf_via_webview2(
    nav_url: &str,
    user_data_dir: &std::path::Path,
    pdf_out: &std::path::Path,
) -> webview2_com::Result<bool> {
    use std::sync::mpsc;
    use windows::core::{Error as WinError, Interface, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, CW_USEDEFAULT, WNDCLASSW,
        WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Controller, ICoreWebView2_7,
    };
    use webview2_com::{
        CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
        NavigationCompletedEventHandler, PrintToPdfCompletedHandler,
    };

    // ── COM init (STA) + teardown guard ────────────────────────────────────
    CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com = ComGuard;

    // ── Hidden host window (the controller needs a parent HWND) ─────────────
    unsafe extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        DefWindowProcW(h, m, w, l)
    }
    let hmodule = GetModuleHandleW(None)?;
    let hinstance = HINSTANCE(hmodule.0);
    let class_name = HSTRING::from("RevenantPdfHost");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    // Idempotent across exports: a second RegisterClassW for the same name fails
    // with CLASS_ALREADY_EXISTS, but the class is registered so CreateWindow works.
    RegisterClassW(&wc);
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        PCWSTR(class_name.as_ptr()),
        PCWSTR(class_name.as_ptr()),
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1024,
        768,
        None,
        None,
        Some(hinstance),
        None,
    )?;
    struct WindowGuard(HWND);
    impl Drop for WindowGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    let _win = WindowGuard(hwnd);

    // ── Environment (async, message-pumped) ─────────────────────────────────
    let environment = {
        let (tx, rx) = mpsc::channel();
        let user_data = HSTRING::from(user_data_dir.to_string_lossy().as_ref());
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    PCWSTR(user_data.as_ptr()),
                    None,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, environment| {
                error_code?;
                tx.send(environment.ok_or_else(|| WinError::from(E_POINTER)))
                    .expect("send environment over channel");
                Ok(())
            }),
        )?;
        rx.recv().expect("receive environment")?
    };

    // ── Controller bound to the hidden window (async, message-pumped) ────────
    let controller: ICoreWebView2Controller = {
        let (tx, rx) = mpsc::channel();
        let env = environment.clone();
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                env.CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, controller| {
                error_code?;
                tx.send(controller.ok_or_else(|| WinError::from(E_POINTER)))
                    .expect("send controller over channel");
                Ok(())
            }),
        )?;
        rx.recv().expect("receive controller")?
    };

    controller.SetIsVisible(false)?;
    controller.SetBounds(RECT { left: 0, top: 0, right: 1024, bottom: 768 })?;
    let webview = controller.CoreWebView2()?;

    // ── Navigate to the bundle and wait for load (message-pumped) ───────────
    {
        let (tx, rx) = mpsc::channel();
        let handler = NavigationCompletedEventHandler::create(Box::new(move |_sender, _args| {
            tx.send(()).expect("send navigation-completed over channel");
            Ok(())
        }));
        let mut token: i64 = 0;
        webview.add_NavigationCompleted(&handler, &mut token)?;
        let url = HSTRING::from(nav_url);
        webview.Navigate(PCWSTR(url.as_ptr()))?;
        let nav = webview2_com::wait_with_pump(rx);
        webview.remove_NavigationCompleted(token)?;
        nav.map_err(|_| WinError::from(E_POINTER))?;
    }

    // ── PrintToPdf to the temp output (async, message-pumped) ───────────────
    let print_ok = {
        let webview7: ICoreWebView2_7 = webview.cast()?;
        let pdf_path = HSTRING::from(pdf_out.to_string_lossy().as_ref());
        let (tx, rx) = mpsc::channel();
        PrintToPdfCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                // None print settings → WebView2 defaults (CSS @page in the bundle
                // controls size/margins).
                webview7
                    .PrintToPdf(PCWSTR(pdf_path.as_ptr()), None, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, is_successful| {
                error_code?;
                tx.send(is_successful)
                    .expect("send print result over channel");
                Ok(())
            }),
        )?;
        rx.recv().expect("receive print result")
    };

    let _ = controller.Close();
    Ok(print_ok)
}

// ---------------------------------------------------------------------------
// A7 — read_file_bytes
// ---------------------------------------------------------------------------

/// Read arbitrary bytes from `image_path`, confined to `doc_path`'s parent
/// directory (and all subdirectories).
///
/// Security guards (mirroring `export_obsidian`):
/// 1. `has_parent_traversal` pre-check — rejects dot-dot before canonicalize.
/// 2. Canonicalize `doc_path` to derive the allowed root.
/// 3. `assert_confined(image_path, &[doc_parent])` — lexical starts_with guard.
///
/// On success returns the raw bytes as a base64 string.  On failure (out-of-dir,
/// unreadable, etc.) returns `IO_ERROR`; the frontend treats this as "skip" and
/// degrades to alt text.
pub fn read_file_bytes(doc_path: &Path, image_path: &Path) -> IpcResult<String> {
    // 1. Traversal pre-guard.
    if crate::paths::has_parent_traversal(image_path) {
        return Err(IpcError {
            code: "IO_ERROR".into(),
            message: format!(
                "image path '{}' contains a parent-directory traversal",
                image_path.display()
            ),
        });
    }

    // 2. Derive the allowed root from the document's canonical parent.
    let canon_doc = std::fs::canonicalize(doc_path).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not canonicalize doc path '{}': {e}", doc_path.display()),
    })?;
    let doc_parent = canon_doc.parent().ok_or_else(|| IpcError {
        code: "IO_ERROR".into(),
        message: format!("doc path '{}' has no parent directory", doc_path.display()),
    })?;

    // 3. Resolve relative image paths against the document's parent directory so
    //    that references like "./images/fig.png" are found relative to the doc,
    //    not the process CWD (which is unrelated in a Tauri app).
    //    Absolute paths pass through unchanged.
    let resolved_image = if image_path.is_absolute() {
        image_path.to_path_buf()
    } else {
        doc_parent.join(image_path)
    };

    // 4. Confinement check — canonicalize the resolved path so symlinks like
    //    /var → /private/var (macOS) are resolved before the starts_with comparison.
    let canon_image = std::fs::canonicalize(&resolved_image).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not canonicalize image path '{}': {e}", resolved_image.display()),
    })?;
    crate::paths::assert_confined(&canon_image, &[doc_parent.to_path_buf()]).map_err(|_| IpcError {
        code: "IO_ERROR".into(),
        message: format!(
            "image path '{}' is outside the document directory '{}'",
            resolved_image.display(),
            doc_parent.display()
        ),
    })?;

    // 5. Read and base64-encode (use the canonicalized path).
    let bytes = std::fs::read(&canon_image).map_err(|e| IpcError {
        code: "IO_ERROR".into(),
        message: format!("could not read '{}': {e}", resolved_image.display()),
    })?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
