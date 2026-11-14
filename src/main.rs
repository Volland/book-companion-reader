//! Book Companion launcher.
//!
//! The product is an Obsidian plugin (main.js, manifest.json, styles.css, built from the TypeScript in src/).
//! This small program helps around it:
//!   book-companion                       open the live preview (the real reader with a sample book) in your browser
//!   book-companion --install <vault>     copy the plugin into <vault>/.obsidian/plugins/book-companion-reader
//!   book-companion --screenshot <png>    picture of the preview (headless Chrome, never takes focus)
//!   book-companion --self-test <json>    run the reader through its core loop and save the results

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const PLUGIN_ID: &str = "book-companion-reader";
const PLUGIN_FILES: [&str; 3] = ["main.js", "manifest.json", "styles.css"];

fn app_dir() -> PathBuf {
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if built.join("manifest.json").exists() {
        return built;
    }
    // next to the program, or two folders up from target/<profile>/
    let exe = env::current_exe().unwrap_or_default();
    for anc in exe.ancestors() {
        if anc.join("manifest.json").exists() && anc.join("preview").exists() {
            return anc.to_path_buf();
        }
    }
    env::current_dir().unwrap_or_default()
}

fn absolute(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        env::current_dir().unwrap_or_default().join(path)
    }
}

fn find_browser() -> Option<PathBuf> {
    let home = env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
        "/Applications/Chromium.app/Contents/MacOS/Chromium".into(),
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser".into(),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
        "/usr/bin/google-chrome".into(),
        "/usr/bin/chromium".into(),
        "/usr/bin/chromium-browser".into(),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".into(),
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe".into(),
    ];
    // Playwright's bundled Chromium, if present
    if let Ok(rd) = fs::read_dir(format!("{home}/Library/Caches/ms-playwright")) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("chromium-") {
                candidates.push(e.path().join("chrome-mac/Chromium.app/Contents/MacOS/Chromium"));
                candidates.push(e.path().join("chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"));
            }
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/").replace(' ', "%20");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn node_build(app: &Path, mode: &str) -> bool {
    let target = match mode {
        "preview" => app.join("preview/preview.js"),
        "test" => app.join("test/out/selftest.js"),
        _ => app.join("main.js"),
    };
    let ok = Command::new("node")
        .arg("esbuild.config.mjs")
        .arg(mode)
        .current_dir(app)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok || target.exists()
}

fn screenshot(out: &str) -> i32 {
    let app = app_dir();
    let out = absolute(out);
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !node_build(&app, "preview") {
        eprintln!("Couldn't build the preview (is Node.js installed?).");
        return 1;
    }
    let Some(browser) = find_browser() else {
        eprintln!("No Chrome, Chromium, Brave or Edge found to draw the preview.");
        return 1;
    };
    let profile = env::temp_dir().join(format!("book-companion-shot-{}", std::process::id()));
    // Headless: no window is shown, so nothing ever takes focus from what you're doing.
    let status = Command::new(&browser)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1500,900",
            "--virtual-time-budget=6000",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--screenshot={}", out.display()))
        .arg(file_url(&app.join("preview/index.html")))
        .output();
    let _ = fs::remove_dir_all(&profile);
    match status {
        Ok(_) if out.exists() && fs::metadata(&out).map(|m| m.len() > 10_000).unwrap_or(false) => {
            println!("Saved {}", out.display());
            0
        }
        Ok(o) => {
            eprintln!("The browser didn't save a picture: {}", String::from_utf8_lossy(&o.stderr));
            1
        }
        Err(e) => {
            eprintln!("Couldn't start the browser: {e}");
            1
        }
    }
}

fn self_test(out: &str) -> i32 {
    let app = app_dir();
    let out = absolute(out);
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !node_build(&app, "test") {
        eprintln!("Couldn't build the self-test (is Node.js installed?).");
        return 1;
    }
    match Command::new("node")
        .arg(app.join("test/out/selftest.js"))
        .arg("--self-test")
        .arg(&out)
        .current_dir(&app)
        .status()
    {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("Couldn't run Node.js: {e}");
            1
        }
    }
}

fn install(vault: &str) -> i32 {
    let app = app_dir();
    let vault = absolute(vault);
    if !vault.join(".obsidian").exists() {
        eprintln!("{} doesn't look like an Obsidian vault (no .obsidian folder). Open it in Obsidian once first.", vault.display());
        return 1;
    }
    if !app.join("main.js").exists() && !node_build(&app, "production") {
        eprintln!("The plugin isn't built yet. Run `npm run build` in {}.", app.display());
        return 1;
    }
    let dest = vault.join(".obsidian/plugins").join(PLUGIN_ID);
    if let Err(e) = fs::create_dir_all(&dest) {
        eprintln!("Couldn't create {}: {e}", dest.display());
        return 1;
    }
    for f in PLUGIN_FILES {
        if let Err(e) = fs::copy(app.join(f), dest.join(f)) {
            eprintln!("Couldn't copy {f}: {e}");
            return 1;
        }
    }
    println!("Installed into {}.", dest.display());
    println!("In Obsidian: Settings → Community plugins → turn on \"Book Companion Reader\" (reload Obsidian if it isn't listed).");
    println!("For phones: the plugin folder syncs with your vault (Obsidian Sync, iCloud, …) and works there too.");
    0
}

fn open_preview() -> i32 {
    let app = app_dir();
    node_build(&app, "preview");
    let url = file_url(&app.join("preview/index.html"));
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    println!("Book Companion Reader — an Obsidian plugin.");
    println!("Opening the preview: {url}");
    println!("To use it in Obsidian: book-companion --install \"/path/to/your/vault\"");
    let _ = Command::new(opener).arg(&url).status();
    0
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let value = |flag: &str| -> Option<String> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
    };
    let code = if let Some(out) = value("--screenshot") {
        screenshot(&out)
    } else if let Some(out) = value("--self-test") {
        self_test(&out)
    } else if let Some(vault) = value("--install") {
        install(&vault)
    } else {
        open_preview()
    };
    exit(code);
}
