use crate::{
    ensure_allowed_existing_image_file, wait_for_file_access_restore_state, FileAction,
    FsAccessState,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Channel, Manager};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_LOCAL_BACKGROUNDS: usize = 3;
static LIBRARY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackground {
    id: String,
    label: String,
    extension: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundLibrary {
    downloaded_official_ids: Vec<String>,
    local_backgrounds: Vec<LocalBackground>,
}

fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("reading-backgrounds");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn local_index_path(dir: &Path) -> PathBuf {
    dir.join("local-index.json")
}

fn read_local_index(dir: &Path) -> Result<Vec<LocalBackground>, String> {
    let path = local_index_path(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let items: Vec<LocalBackground> =
        serde_json::from_slice(&fs::read(path).map_err(|err| err.to_string())?)
            .map_err(|err| err.to_string())?;
    Ok(items
        .into_iter()
        .filter(|item| {
            valid_local_id(&item.id)
                && valid_extension(&item.extension)
                && dir
                    .join(format!("{}.{}", item.id, item.extension))
                    .is_file()
                && dir.join(format!("{}-thumb.jpg", item.id)).is_file()
        })
        .take(MAX_LOCAL_BACKGROUNDS)
        .collect())
}

fn write_local_index(dir: &Path, items: &[LocalBackground]) -> Result<(), String> {
    let pending = dir.join("local-index.json.tmp");
    fs::write(
        &pending,
        serde_json::to_vec(items).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::rename(pending, local_index_path(dir)).map_err(|err| err.to_string())
}

fn valid_local_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, ch)| {
            if [8, 13, 18, 23].contains(&i) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
}

fn valid_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
}

fn official_url(id: &str) -> Option<&'static str> {
    match id {
        "snow" => Some("https://raw.githubusercontent.com/we-used-to-be/Guanmo-open/main/resources/reading-backgrounds/snow.png"),
        "sea" => Some("https://raw.githubusercontent.com/we-used-to-be/Guanmo-open/main/resources/reading-backgrounds/sea.png"),
        "stars" => Some("https://raw.githubusercontent.com/we-used-to-be/Guanmo-open/main/resources/reading-backgrounds/stars.png"),
        _ => None,
    }
}

fn official_size(id: &str) -> Option<u64> {
    match id {
        "snow" => Some(1_709_683),
        "sea" => Some(1_915_040),
        "stars" => Some(2_153_446),
        _ => None,
    }
}

#[tauri::command]
pub fn list_reading_backgrounds(app: tauri::AppHandle) -> Result<BackgroundLibrary, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "background library lock failed")?;
    let dir = library_dir(&app)?;
    Ok(BackgroundLibrary {
        downloaded_official_ids: ["snow", "sea", "stars"]
            .into_iter()
            .filter(|id| {
                dir.join(format!("{id}.png"))
                    .metadata()
                    .map(|metadata| Some(metadata.len()) == official_size(id))
                    .unwrap_or(false)
            })
            .map(str::to_string)
            .collect(),
        local_backgrounds: read_local_index(&dir)?,
    })
}

#[tauri::command]
pub fn read_reading_background(
    app: tauri::AppHandle,
    id: String,
    thumbnail: bool,
) -> Result<Vec<u8>, String> {
    let dir = library_dir(&app)?;
    let path = if official_url(&id).is_some() && !thumbnail {
        dir.join(format!("{id}.png"))
    } else {
        let item = read_local_index(&dir)?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("background not found")?;
        if thumbnail {
            dir.join(format!("{}-thumb.jpg", item.id))
        } else {
            dir.join(format!("{}.{}", item.id, item.extension))
        }
    };
    let file = fs::File::open(path).map_err(|err| err.to_string())?;
    crate::read_bytes_with_limit(file, MAX_IMAGE_BYTES as u64)
}

#[tauri::command]
pub fn import_reading_background(
    app: tauri::AppHandle,
    path: String,
    id: String,
    thumbnail: Vec<u8>,
) -> Result<LocalBackground, String> {
    if !valid_local_id(&id) {
        return Err("invalid background id".into());
    }
    if thumbnail.len() > 200_000 || !thumbnail.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err("invalid background thumbnail".into());
    }
    let state = app.state::<FsAccessState>();
    wait_for_file_access_restore_state(state.inner());
    let source =
        ensure_allowed_existing_image_file(&state, &PathBuf::from(path), FileAction::ReadBinary)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !valid_extension(&extension) {
        return Err("unsupported background format".into());
    }
    let bytes = crate::read_bytes_with_limit(
        fs::File::open(&source).map_err(|err| err.to_string())?,
        MAX_IMAGE_BYTES as u64,
    )?;
    let label = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("本地背景")
        .chars()
        .take(48)
        .collect();
    let item = LocalBackground {
        id,
        label,
        extension,
    };
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "background library lock failed")?;
    let dir = library_dir(&app)?;
    let mut items = read_local_index(&dir)?;
    if items.len() >= MAX_LOCAL_BACKGROUNDS {
        return Err("最多添加 3 张背景".into());
    }
    if items.iter().any(|existing| existing.id == item.id) {
        return Err("background already exists".into());
    }
    let image_path = dir.join(format!("{}.{}", item.id, item.extension));
    let thumbnail_path = dir.join(format!("{}-thumb.jpg", item.id));
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&image_path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|err| err.to_string())?;
    if let Err(err) = fs::write(&thumbnail_path, thumbnail) {
        let _ = fs::remove_file(&image_path);
        return Err(err.to_string());
    }
    items.push(item.clone());
    if let Err(err) = write_local_index(&dir, &items) {
        let _ = fs::remove_file(&image_path);
        let _ = fs::remove_file(&thumbnail_path);
        return Err(err);
    }
    Ok(item)
}

#[tauri::command]
pub fn delete_reading_background(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "background library lock failed")?;
    let dir = library_dir(&app)?;
    let mut items = read_local_index(&dir)?;
    let index = items
        .iter()
        .position(|item| item.id == id)
        .ok_or("background not found")?;
    let item = items.remove(index);
    let image = dir.join(format!("{}.{}", item.id, item.extension));
    let thumbnail = dir.join(format!("{}-thumb.jpg", item.id));
    let image_pending = dir.join(format!("{}.delete", item.id));
    let thumbnail_pending = dir.join(format!("{}-thumb.delete", item.id));
    fs::rename(&image, &image_pending).map_err(|err| err.to_string())?;
    if let Err(err) = fs::rename(&thumbnail, &thumbnail_pending) {
        let _ = fs::rename(&image_pending, &image);
        return Err(err.to_string());
    }
    if let Err(err) = write_local_index(&dir, &items) {
        let _ = fs::rename(&image_pending, &image);
        let _ = fs::rename(&thumbnail_pending, &thumbnail);
        return Err(err);
    }
    let _ = fs::remove_file(image_pending);
    let _ = fs::remove_file(thumbnail_pending);
    Ok(())
}

#[tauri::command]
pub async fn download_reading_background(
    app: tauri::AppHandle,
    id: String,
    progress: Channel<u8>,
) -> Result<(), String> {
    let url = official_url(&id).ok_or("unknown official background")?;
    let expected_size = official_size(&id).ok_or("unknown official background")?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;
    let total = response.content_length().unwrap_or(expected_size);
    if total != expected_size {
        return Err("invalid background size".into());
    }
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| err.to_string())?;
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("background exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = progress.send(((bytes.len() as u64 * 100) / total).min(99) as u8);
    }
    if bytes.len() as u64 != expected_size || !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
    {
        return Err("invalid background download".into());
    }
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "background library lock failed")?;
    let dir = library_dir(&app)?;
    let pending = dir.join(format!("{id}.png.tmp"));
    fs::write(&pending, bytes).map_err(|err| err.to_string())?;
    fs::rename(pending, dir.join(format!("{id}.png"))).map_err(|err| err.to_string())?;
    let _ = progress.send(100);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_ids_cannot_escape_the_owned_directory() {
        assert!(valid_local_id("00000000-0000-0000-0000-000000000001"));
        assert!(!valid_local_id("../outside"));
        assert!(!valid_extension("../png"));
        assert!(official_url("../outside").is_none());
    }

    #[test]
    fn index_can_be_updated_without_losing_existing_backgrounds() {
        let dir = std::env::temp_dir().join(format!(
            "guanmo-background-index-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let first = LocalBackground {
            id: "00000000-0000-0000-0000-000000000001".into(),
            label: "第一张".into(),
            extension: "png".into(),
        };
        let second = LocalBackground {
            id: "00000000-0000-0000-0000-000000000002".into(),
            label: "第二张".into(),
            extension: "png".into(),
        };
        write_local_index(&dir, &[first.clone()]).unwrap();
        write_local_index(&dir, &[first, second]).unwrap();
        let saved: Vec<LocalBackground> =
            serde_json::from_slice(&fs::read(local_index_path(&dir)).unwrap()).unwrap();
        assert_eq!(saved.len(), 2);
        fs::remove_file(local_index_path(&dir)).unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
