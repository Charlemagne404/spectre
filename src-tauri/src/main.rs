#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

fn write_report(directory: &Path, file_name: &str, contents: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    if file_name.len() > 160
        || !file_name.starts_with("spectre-")
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
        || file_name.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ' '))
        })
    {
        return Err("Report filename is invalid.".into());
    }
    let (stem, extension) = file_name
        .rsplit_once('.')
        .ok_or_else(|| "Report filename must end in .json or .html.".to_string())?;
    if stem.is_empty() || !matches!(extension, "json" | "html") {
        return Err("Only JSON and HTML reports can be exported.".into());
    }

    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not open the Downloads folder: {error}"))?;
    for suffix in 0..10_000 {
        let candidate = if suffix == 0 {
            file_name.to_string()
        } else {
            format!("{stem} ({suffix}).{extension}")
        };
        let destination = directory.join(candidate);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(contents.as_bytes()) {
                    let _ = fs::remove_file(&destination);
                    return Err(format!("Could not write the report: {error}"));
                }
                return Ok(destination);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save the report: {error}")),
        }
    }
    Err("Too many reports with this name already exist.".into())
}

#[tauri::command]
fn save_report(app: AppHandle, file_name: String, contents: String) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("Could not locate the Downloads folder: {error}"))?;
    write_report(&directory, &file_name, &contents).map(|path| path.to_string_lossy().into_owned())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_report])
        .run(tauri::generate_context!())
        .expect("error while running Spectre");
}

#[cfg(test)]
mod tests {
    use super::write_report;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "spectre-report-test-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn report_export_never_overwrites_existing_files() {
        let directory = test_directory();
        let first = write_report(&directory, "spectre-sample-analysis.json", "first").unwrap();
        let second = write_report(&directory, "spectre-sample-analysis.json", "second").unwrap();
        assert_eq!(first.file_name().unwrap(), "spectre-sample-analysis.json");
        assert_eq!(
            second.file_name().unwrap(),
            "spectre-sample-analysis (1).json"
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn report_export_rejects_paths_and_unsupported_extensions() {
        let directory = test_directory();
        assert!(write_report(&directory, "../spectre-report.json", "data").is_err());
        assert!(write_report(&directory, "spectre-report.txt", "data").is_err());
        assert!(!directory.exists());
    }
}
