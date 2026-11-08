use reqwest::cookie::Jar;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
struct PlayerSession {
    base_url: Url,
    client: Client,
    csrf_token: String,
}

struct AppState {
    session: Mutex<Option<PlayerSession>>,
    heartbeat_stop: Mutex<Option<Arc<AtomicBool>>>,
    volume_revision: Arc<AtomicU64>,
    audio_commands: mpsc::Sender<AudioCommand>,
}

enum AudioCommand {
    Play {
        path: std::path::PathBuf,
        volume: f32,
        fallback_duration: Duration,
    },
    Pause,
    Resume,
    SetVolume(f32),
    Stop,
}

#[cfg(not(target_os = "android"))]
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopPlaybackProgress {
    current_time: f64,
    duration: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    csrf_token: String,
    player: PlayerInfo,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlayerInfo {
    name: String,
    location: String,
    client: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QueueItem {
    id: String,
    kind: String,
    title: String,
    artist: String,
    duration: u32,
    cover: String,
    audio: String,
    rotation: String,
    #[serde(default)]
    audio_url: String,
    #[serde(default)]
    cover_url: String,
}

#[derive(Deserialize)]
struct QueueResponse {
    item: Option<QueueItem>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResult {
    player: PlayerInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackResult {
    item: Option<QueueItem>,
    message: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlayerVolumeSettings {
    #[serde(alias = "music_volume")]
    music_volume: f32,
    #[serde(alias = "ad_volume")]
    ad_volume: f32,
    #[serde(alias = "volume_revision")]
    volume_revision: u64,
    #[serde(default, alias = "volume_updated_at")]
    volume_updated_at: String,
}

#[derive(Deserialize)]
struct ApiError {
    error: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Deserialize, Serialize)]
struct SavedCredentials {
    username: String,
    password: String,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.cityshake.player", "player-account")
        .map_err(|error| format!("Не удалось открыть защищённое хранилище: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn save_credentials(username: &str, password: &str) -> Result<(), String> {
    let entry = credential_entry()?;
    let value = serde_json::to_string(&SavedCredentials {
        username: username.to_string(),
        password: password.to_string(),
    })
    .map_err(|error| error.to_string())?;
    entry
        .set_password(&value)
        .map_err(|error| format!("Не удалось сохранить вход в защищённом хранилище: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_credentials() -> Result<Option<SavedCredentials>, String> {
    let entry = credential_entry()?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!("Не удалось прочитать сохранённый вход: {error}"));
        }
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|error| format!("Сохранённые данные входа повреждены: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn delete_credentials() -> Result<(), String> {
    let entry = credential_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Не удалось удалить сохранённый вход: {error}")),
    }
}

impl AppState {
    fn new(app: &AppHandle) -> Self {
        let (audio_commands, receiver) = mpsc::channel();
        spawn_audio_worker(app.clone(), receiver);
        Self {
            session: Mutex::new(None),
            heartbeat_stop: Mutex::new(None),
            volume_revision: Arc::new(AtomicU64::new(u64::MAX)),
            audio_commands,
        }
    }
}

fn spawn_audio_worker(app: AppHandle, receiver: mpsc::Receiver<AudioCommand>) {
    #[cfg(not(target_os = "android"))]
    std::thread::spawn(move || {
        use rodio::{MixerDeviceSink, Player};
        use std::fs;
        use std::time::Instant;

        let mut _output: Option<MixerDeviceSink> = None;
        let mut sink: Option<Player> = None;
        let mut active = false;
        let mut paused = false;
        let mut current_file: Option<std::path::PathBuf> = None;
        let mut current_volume = 1.0;
        let mut current_duration = Duration::ZERO;
        let mut last_position = Duration::ZERO;
        let mut last_progress_at = Instant::now();
        let mut next_progress_at = Instant::now();
        let mut next_device_check_at = Instant::now();
        let mut next_recovery_at = Instant::now();
        let mut output_device_name: Option<String> = None;

        loop {
            match receiver.recv_timeout(Duration::from_millis(120)) {
                Ok(AudioCommand::Play {
                    path,
                    volume,
                    fallback_duration,
                }) => {
                    active = false;
                    paused = false;
                    if let Some(previous) = sink.take() {
                        previous.stop();
                    }
                    if let Some(previous_file) = current_file.take() {
                        let _ = fs::remove_file(previous_file);
                    }
                    _output = None;
                    output_device_name = None;
                    match open_desktop_audio(&path, volume, Duration::ZERO, fallback_duration) {
                        Ok((stream, player, duration)) => {
                            output_device_name = default_output_device_name();
                            _output = Some(stream);
                            sink = Some(player);
                            current_duration = duration;
                            current_volume = volume.clamp(0.0, 1.0);
                            last_position = Duration::ZERO;
                            last_progress_at = Instant::now();
                            next_progress_at = Instant::now();
                            next_device_check_at = Instant::now();
                            next_recovery_at = Instant::now();
                            current_file = Some(path);
                            active = true;
                        }
                        Err(error) => {
                            if error.starts_with("Не удалось открыть аудиовыход:")
                            {
                                current_volume = volume.clamp(0.0, 1.0);
                                current_duration = fallback_duration;
                                current_file = Some(path);
                                last_position = Duration::ZERO;
                                last_progress_at = Instant::now();
                                next_recovery_at = Instant::now() + Duration::from_secs(5);
                                active = true;
                            } else {
                                let _ = fs::remove_file(path);
                            }
                            let _ = app.emit("player-playback-error", error);
                        }
                    }
                }
                Ok(AudioCommand::Pause) => {
                    paused = true;
                    if let Some(sink) = sink.as_ref() {
                        sink.pause();
                    }
                }
                Ok(AudioCommand::Resume) => {
                    paused = false;
                    if let Some(sink) = sink.as_ref() {
                        sink.play();
                        last_progress_at = Instant::now();
                    } else if active {
                        next_recovery_at = Instant::now();
                    }
                }
                Ok(AudioCommand::SetVolume(volume)) => {
                    if let Some(sink) = sink.as_ref() {
                        sink.set_volume(volume.clamp(0.0, 1.0));
                    }
                }
                Ok(AudioCommand::Stop) => {
                    active = false;
                    paused = false;
                    if let Some(sink) = sink.take() {
                        sink.stop();
                    }
                    if let Some(path) = current_file.take() {
                        let _ = fs::remove_file(path);
                    }
                    _output = None;
                    output_device_name = None;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if !active {
                continue;
            }

            let now = Instant::now();
            if sink.as_ref().is_some_and(Player::empty) {
                if let Some(player) = sink.as_ref() {
                    last_position = player.get_pos();
                }
                let _ = app.emit(
                    "desktop-playback-progress",
                    DesktopPlaybackProgress {
                        current_time: last_position.as_secs_f64(),
                        duration: current_duration
                            .as_secs_f64()
                            .max(last_position.as_secs_f64()),
                    },
                );
                active = false;
                sink = None;
                _output = None;
                output_device_name = None;
                if let Some(path) = current_file.take() {
                    let _ = fs::remove_file(path);
                }
                let _ = app.emit("player-track-ended", ());
                continue;
            }

            let mut should_recover = !paused && sink.is_none() && now >= next_recovery_at;
            if let Some(player) = sink.as_ref() {
                let position = player.get_pos();
                if position > last_position {
                    last_position = position;
                    last_progress_at = now;
                }

                if !paused
                    && !player.is_paused()
                    && now.duration_since(last_progress_at) >= Duration::from_secs(8)
                {
                    should_recover = true;
                }
            }

            if now >= next_device_check_at {
                next_device_check_at = now + Duration::from_secs(2);
                if let (Some(current), Some(default)) =
                    (output_device_name.as_ref(), default_output_device_name())
                {
                    if current != &default {
                        should_recover = true;
                    }
                }
            }

            if should_recover && now >= next_recovery_at {
                next_recovery_at = now + Duration::from_secs(5);
                if let Some(player) = sink.take() {
                    player.stop();
                }
                _output = None;
                output_device_name = None;
                let recovered = current_file
                    .as_ref()
                    .ok_or_else(|| "Не найден файл текущего трека.".to_string())
                    .and_then(|path| {
                        open_desktop_audio(path, current_volume, last_position, current_duration)
                    });
                match recovered {
                    Ok((stream, player, duration)) => {
                        output_device_name = default_output_device_name();
                        _output = Some(stream);
                        last_position = player.get_pos();
                        current_duration = duration;
                        sink = Some(player);
                        last_progress_at = Instant::now();
                        next_recovery_at = Instant::now() + Duration::from_secs(5);
                        let _ = app.emit("player-playback-recovered", ());
                    }
                    Err(error) => {
                        sink = None;
                        last_progress_at = Instant::now();
                        let message = if error.starts_with("Не удалось открыть аудиовыход:")
                        {
                            format!("Звуковое устройство переподключается: {error}")
                        } else {
                            active = false;
                            if let Some(path) = current_file.take() {
                                let _ = fs::remove_file(path);
                            }
                            error
                        };
                        let _ = app.emit("player-playback-error", message);
                    }
                }
            }

            if now >= next_progress_at {
                next_progress_at = now + Duration::from_millis(500);
                let position = sink.as_ref().map(Player::get_pos).unwrap_or(last_position);
                last_position = last_position.max(position);
                let duration = current_duration
                    .as_secs_f64()
                    .max(last_position.as_secs_f64());
                let _ = app.emit(
                    "desktop-playback-progress",
                    DesktopPlaybackProgress {
                        current_time: last_position.as_secs_f64(),
                        duration,
                    },
                );
            }
        }
    });

    #[cfg(target_os = "android")]
    {
        let _ = app;
        drop(receiver);
    }
}

#[cfg(not(target_os = "android"))]
fn open_desktop_audio(
    path: &std::path::Path,
    volume: f32,
    start_at: Duration,
    fallback_duration: Duration,
) -> Result<(rodio::MixerDeviceSink, rodio::Player, Duration), String> {
    use rodio::{Decoder, DeviceSinkBuilder, Player, Source};
    use std::fs::File;
    use std::io::BufReader;

    let output = DeviceSinkBuilder::open_default_sink()
        .map_err(|error| format!("Не удалось открыть аудиовыход: {error}"))?;
    let file = File::open(path).map_err(|error| format!("Не удалось открыть трек: {error}"))?;
    let mut decoder = Decoder::try_from(BufReader::new(file))
        .map_err(|error| format!("Не удалось декодировать трек: {error}"))?;
    let duration = decoder.total_duration().unwrap_or(fallback_duration);
    if !start_at.is_zero() {
        decoder
            .try_seek(start_at)
            .map_err(|error| format!("Не удалось продолжить трек с текущей позиции: {error}"))?;
    }

    let player = Player::connect_new(output.mixer());
    player.append(decoder);
    player.set_volume(volume.clamp(0.0, 1.0));
    player.play();
    Ok((output, player, duration))
}

#[cfg(not(target_os = "android"))]
fn default_output_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    rodio::cpal::default_host()
        .default_output_device()?
        .id()
        .ok()
        .map(|id| id.to_string())
}

fn normalized_service_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    let candidate = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let mut url =
        Url::parse(&candidate).map_err(|_| "Введите корректный адрес сервиса.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Используйте адрес сервиса с протоколом HTTP или HTTPS.".into());
    }
    let path = url.path().trim_end_matches('/');
    let normalized_path = if path.is_empty() {
        "/".to_string()
    } else {
        format!("{path}/")
    };
    url.set_path(&normalized_path);
    Ok(url)
}

fn service_endpoint(base_url: &Url, path: &str) -> Result<Url, String> {
    base_url.join(path).map_err(|error| error.to_string())
}

fn stop_heartbeat(state: &AppState) {
    if let Ok(mut slot) = state.heartbeat_stop.lock() {
        if let Some(stop) = slot.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

fn start_heartbeat(state: &AppState, session: PlayerSession, app: AppHandle) {
    stop_heartbeat(state);
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = state.heartbeat_stop.lock() {
        *slot = Some(stop.clone());
    }
    let volume_revision = state.volume_revision.clone();

    tauri::async_runtime::spawn(async move {
        let Ok(url) = service_endpoint(&session.base_url, "api/player/heartbeat/") else {
            return;
        };
        let Ok(volume_url) = service_endpoint(&session.base_url, "api/player/volume/") else {
            return;
        };
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match session
                .client
                .post(url.clone())
                .header("X-CSRFToken", &session.csrf_token)
                .header("Origin", session.base_url.origin().ascii_serialization())
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    if let Ok(response) = session.client.get(volume_url.clone()).send().await {
                        if response.status().is_success() {
                            if let Ok(settings) = response.json::<PlayerVolumeSettings>().await {
                                let previous = volume_revision
                                    .swap(settings.volume_revision, Ordering::Relaxed);
                                if previous != settings.volume_revision {
                                    let _ = app.emit("player-volume-updated", settings);
                                }
                            }
                        }
                    }
                }
                Ok(response)
                    if response.status().as_u16() == 401
                        || response.status().as_u16() == 403
                        || response.status().as_u16() == 409 =>
                {
                    let message = response_error(response).await;
                    let _ = app.emit("player-session-error", message);
                    break;
                }
                _ => {}
            }
        }
    });
}

async fn response_error(response: Response) -> String {
    let status = response.status();
    match response.json::<ApiError>().await {
        Ok(body) => body
            .error
            .unwrap_or_else(|| format!("Ошибка сервиса ({status}).")),
        Err(_) => format!("Ошибка сервиса ({status})."),
    }
}

async fn queue_response(
    session: &PlayerSession,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<PlaybackResult, String> {
    let url = service_endpoint(&session.base_url, path)?;
    let mut request = session
        .client
        .post(url)
        .header("X-CSRFToken", &session.csrf_token)
        .header("Origin", session.base_url.origin().ascii_serialization());
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Не удалось связаться с сервисом: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let message = response_error(response).await;
        if status == 409 {
            return Err(format!("__PLAYER_SESSION_BUSY__:{message}"));
        }
        return Err(message);
    }
    let mut queue: QueueResponse = response
        .json()
        .await
        .map_err(|error| format!("Некорректный ответ сервиса: {error}"))?;
    if let Some(item) = queue.item.as_mut() {
        item.audio_url =
            service_endpoint(&session.base_url, item.audio.trim_start_matches('/'))?.to_string();
        item.cover_url = if item.cover.is_empty() {
            String::new()
        } else {
            service_endpoint(&session.base_url, item.cover.trim_start_matches('/'))?.to_string()
        };
    }
    Ok(PlaybackResult {
        item: queue.item,
        message: queue.message.unwrap_or_default(),
    })
}

#[tauri::command]
async fn native_login(
    state: State<'_, AppState>,
    app: AppHandle,
    base_url: String,
    username: String,
    password: String,
) -> Result<LoginResult, String> {
    authenticate_player(&state, app, base_url, &username, &password, true).await
}

#[tauri::command]
async fn restore_login(
    state: State<'_, AppState>,
    app: AppHandle,
    base_url: String,
) -> Result<Option<LoginResult>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Some(credentials) = load_credentials()? else {
            return Ok(None);
        };
        return authenticate_player(
            &state,
            app,
            base_url,
            &credentials.username,
            &credentials.password,
            false,
        )
        .await
        .map(Some);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, app, base_url);
        Ok(None)
    }
}

#[tauri::command]
async fn clear_saved_credentials() -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        delete_credentials()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
}

async fn authenticate_player(
    state: &AppState,
    app: AppHandle,
    base_url: String,
    username: &str,
    password: &str,
    remember: bool,
) -> Result<LoginResult, String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = remember;

    stop_heartbeat(state);
    let base_url = normalized_service_url(&base_url)?;
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .cookie_provider(jar)
        .user_agent(format!("CityshakePlayer/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let url = service_endpoint(&base_url, "api/player/native/login/")?;
    let platform = client_platform();
    let response = client
        .post(url)
        .json(&serde_json::json!({
            "username": username.trim(),
            "password": password,
            "platform": platform,
            "client_platform": platform,
            "app_version": env!("CARGO_PKG_VERSION"),
            "app_build": env!("CARGO_PKG_VERSION"),
            "operating_system": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
        }))
        .send()
        .await
        .map_err(|error| format!("Не удалось связаться с сервисом: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let login: LoginResponse = response
        .json()
        .await
        .map_err(|error| format!("Некорректный ответ сервиса: {error}"))?;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if remember {
        save_credentials(username.trim(), password)?;
    }

    let session = PlayerSession {
        base_url,
        client,
        csrf_token: login.csrf_token,
    };
    if let Ok(mut slot) = state.session.lock() {
        *slot = Some(session);
    }
    state.volume_revision.store(u64::MAX, Ordering::Relaxed);
    let _ = app.emit("player-session-ready", ());
    Ok(LoginResult {
        player: login.player,
    })
}

fn client_platform() -> &'static str {
    #[cfg(target_os = "android")]
    return "android";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "ios")]
    return "ios";
    #[cfg(target_os = "linux")]
    return "linux";
    #[allow(unreachable_code)]
    "app"
}

async fn request_player_volume(
    session: &PlayerSession,
    body: Option<serde_json::Value>,
) -> Result<PlayerVolumeSettings, String> {
    let url = service_endpoint(&session.base_url, "api/player/volume/")?;
    let request = match body {
        Some(body) => session
            .client
            .post(url)
            .header("X-CSRFToken", &session.csrf_token)
            .header("Origin", session.base_url.origin().ascii_serialization())
            .json(&body),
        None => session.client.get(url),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Не удалось получить настройки громкости: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    response
        .json::<PlayerVolumeSettings>()
        .await
        .map_err(|error| format!("Некорректный ответ настроек громкости: {error}"))
}

#[tauri::command]
async fn get_player_volume(state: State<'_, AppState>) -> Result<PlayerVolumeSettings, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Войдите в аккаунт устройства.")?;
    let settings = request_player_volume(&session, None).await?;
    state
        .volume_revision
        .store(settings.volume_revision, Ordering::Relaxed);
    Ok(settings)
}

#[tauri::command]
async fn set_player_volumes(
    state: State<'_, AppState>,
    music_volume: f32,
    ad_volume: f32,
) -> Result<PlayerVolumeSettings, String> {
    if !music_volume.is_finite()
        || !ad_volume.is_finite()
        || !(0.0..=1.0).contains(&music_volume)
        || !(0.0..=1.0).contains(&ad_volume)
    {
        return Err("Громкость должна быть от 0 до 100%.".into());
    }
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Войдите в аккаунт устройства.")?;
    let settings = request_player_volume(
        &session,
        Some(serde_json::json!({
            "music_volume": music_volume,
            "ad_volume": ad_volume,
        })),
    )
    .await?;
    state
        .volume_revision
        .store(settings.volume_revision, Ordering::Relaxed);
    Ok(settings)
}

#[tauri::command]
fn autostart_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if enabled {
            manager.enable().map_err(|error| error.to_string())?;
        } else {
            manager.disable().map_err(|error| error.to_string())?;
        }
        manager.is_enabled().map_err(|error| error.to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, enabled);
        Ok(false)
    }
}

#[tauri::command]
async fn native_logout(state: State<'_, AppState>) -> Result<(), String> {
    stop_heartbeat(&state);
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .take();
    if let Some(session) = session {
        let url = service_endpoint(&session.base_url, "api/player/native/logout/")?;
        let _ = session
            .client
            .post(url)
            .header("X-CSRFToken", &session.csrf_token)
            .header("Origin", session.base_url.origin().ascii_serialization())
            .send()
            .await;
    }
    let _ = state.audio_commands.send(AudioCommand::Stop);
    Ok(())
}

#[tauri::command]
async fn start_playback(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PlaybackResult, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Войдите в аккаунт устройства.")?;
    let result = queue_response(&session, "api/player/start/", None).await?;
    if result.item.is_some() {
        start_heartbeat(&state, session, app);
    } else {
        stop_heartbeat(&state);
    }
    Ok(result)
}

#[tauri::command]
async fn complete_current(
    state: State<'_, AppState>,
    app: AppHandle,
    event_id: String,
) -> Result<PlaybackResult, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Сессия завершена. Войдите снова.")?;
    let result = queue_response(
        &session,
        "api/player/complete/",
        Some(serde_json::json!({ "event": event_id })),
    )
    .await?;
    if result.item.is_some() {
        start_heartbeat(&state, session, app);
    } else {
        stop_heartbeat(&state);
    }
    Ok(result)
}

#[tauri::command]
async fn desktop_play(
    state: State<'_, AppState>,
    app: AppHandle,
    audio_url: String,
    volume: f32,
    duration: u32,
) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Войдите в аккаунт устройства.")?;
    let audio_url =
        Url::parse(&audio_url).map_err(|_| "Некорректная ссылка на аудио.".to_string())?;
    if audio_url.scheme() != "https" && audio_url.scheme() != "http" {
        return Err("Ссылка на аудио должна использовать HTTP или HTTPS.".into());
    }
    let response = session
        .client
        .get(audio_url)
        .send()
        .await
        .map_err(|error| format!("Не удалось загрузить трек: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Не удалось загрузить аудио: {error}"))?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = cache_dir.join(format!("cityshake-{stamp}.mp3"));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    state
        .audio_commands
        .send(AudioCommand::Play {
            path,
            volume: volume.clamp(0.0, 1.0),
            fallback_duration: Duration::from_secs(duration as u64),
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cache_audio_track(
    state: State<'_, AppState>,
    app: AppHandle,
    audio_url: String,
) -> Result<String, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Не удалось получить сессию.".to_string())?
        .clone()
        .ok_or("Войдите в аккаунт устройства.")?;
    let audio_url =
        Url::parse(&audio_url).map_err(|_| "Некорректная ссылка на аудио.".to_string())?;
    if audio_url.origin() != session.base_url.origin()
        || (audio_url.scheme() != "https" && audio_url.scheme() != "http")
    {
        return Err("Ссылка на аудио не относится к сервису Cityshake.".into());
    }
    let response = session
        .client
        .get(audio_url)
        .send()
        .await
        .map_err(|error| format!("Не удалось загрузить трек: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Не удалось загрузить аудио: {error}"))?;
    if bytes.is_empty() {
        return Err("Сервис вернул пустой аудиофайл.".into());
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        let stale_before =
            std::time::SystemTime::now().checked_sub(Duration::from_secs(72 * 60 * 60));
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("cityshake-audio-") && name.ends_with(".mp3"))
            {
                continue;
            }
            let stale = stale_before
                .zip(
                    entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| metadata.modified().ok()),
                )
                .is_some_and(|(cutoff, modified)| modified < cutoff);
            if stale {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = cache_dir.join(format!("cityshake-audio-{stamp}.mp3"));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "Не удалось подготовить локальный файл аудио.".to_string())
}

#[tauri::command]
fn desktop_set_volume(state: State<'_, AppState>, volume: f32) -> Result<(), String> {
    state
        .audio_commands
        .send(AudioCommand::SetVolume(volume.clamp(0.0, 1.0)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_pause(state: State<'_, AppState>) -> Result<(), String> {
    state
        .audio_commands
        .send(AudioCommand::Pause)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_resume(state: State<'_, AppState>) -> Result<(), String> {
    state
        .audio_commands
        .send(AudioCommand::Resume)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_stop(state: State<'_, AppState>) -> Result<(), String> {
    state
        .audio_commands
        .send(AudioCommand::Stop)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_native_audio::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            app.manage(AppState::new(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_login,
            restore_login,
            clear_saved_credentials,
            native_logout,
            autostart_supported,
            get_autostart_enabled,
            set_autostart_enabled,
            get_player_volume,
            set_player_volumes,
            start_playback,
            complete_current,
            desktop_play,
            cache_audio_track,
            desktop_set_volume,
            desktop_pause,
            desktop_resume,
            desktop_stop
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Cityshake Player");
}
