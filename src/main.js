import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import {
  addStateListener,
  dispose,
  initialize,
  pause as pauseNative,
  play as playNative,
  setSource,
} from 'tauri-plugin-native-audio-api'
import './styles.css'

const SERVICE_URL = 'https://player.cityshake.media'
const MUSIC_VOLUME_KEY = 'cityshake-player.music-volume'
const AD_VOLUME_KEY = 'cityshake-player.ad-volume'
const AUTOSTART_ASKED_KEY = 'cityshake-player.autostart-asked'
const WINDOW_SIZE_KEY = 'cityshake-player.window-size'
const isAndroid = /Android/i.test(navigator.userAgent)
if (isAndroid) {
  document.documentElement.dataset.clientPlatform = 'android'
  document.documentElement.dataset.mobileScreen = 'home'
}
const loginForm = document.querySelector('#connect-form')
const usernameInput = document.querySelector('#player-username')
const passwordInput = document.querySelector('#player-password')
const formError = document.querySelector('#form-error')
const loginCopy = document.querySelector('#login-copy')
const restoreActions = document.querySelector('#restore-actions')
const restoreMessage = document.querySelector('#restore-message')
const submitButton = loginForm.querySelector('button[type="submit"]')
const submitLabel = document.querySelector('#submit-label')
const connectView = document.querySelector('#connect-view')
const playerView = document.querySelector('#player-view')
const playerError = document.querySelector('#player-error')
const playButton = document.querySelector('#play-toggle')
const playLabel = document.querySelector('#play-label')
const playDescription = document.querySelector('#play-description')
const musicVolumeInput = document.querySelector('#music-volume')
const adVolumeInput = document.querySelector('#ad-volume')
const historyList = document.querySelector('#history-list')
const historyEmpty = document.querySelector('#history-empty')
const autostartSetting = document.querySelector('#autostart-setting')
const autostartToggle = document.querySelector('#autostart-toggle')
const autostartDialog = document.querySelector('#autostart-dialog')
const autostartEnableButton = document.querySelector('#autostart-enable')
const autostartSkipButton = document.querySelector('#autostart-skip')
const checkUpdatesButton = document.querySelector('#check-updates')
const playerSettings = document.querySelector('.player-settings')
const updateStatus = document.querySelector('#update-status')
const updateDialog = document.querySelector('#update-dialog')
const updateMessage = document.querySelector('#update-message')
const updateLaterButton = document.querySelector('#update-later')
const updateInstallButton = document.querySelector('#update-install')
const logoutDialog = document.querySelector('#logout-dialog')
const logoutCancelButton = document.querySelector('#logout-cancel')
const logoutConfirmButton = document.querySelector('#logout-confirm')
const mobileNavigation = document.querySelector('#player-navigation')
const mobileSettingsContent = document.querySelector('#mobile-settings-content')
const mobileNavigationButtons = [...mobileNavigation.querySelectorAll('[data-mobile-screen]')]

if (isAndroid) {
  mobileSettingsContent.append(playerSettings)
  playerSettings.open = true
}

const initialMusicVolume = readVolume(MUSIC_VOLUME_KEY, 0.8)
let adVolumeSaved = hasSavedVolume(AD_VOLUME_KEY)
let autostartSupported = false
let pendingDesktopUpdate = null
let pendingAndroidUpdate = null
let checkingForUpdates = false
let playbackRetryTimer = null
let playbackRetryAttempt = 0
let isLoggingOut = false
let volumeSyncTimer = null

const state = {
  player: null,
  currentItem: null,
  isPlaying: false,
  isCompleting: false,
  nativeReady: false,
  nativeCurrentTime: null,
  nativeDuration: null,
  elapsedBase: 0,
  startedAt: null,
  history: [],
  musicVolume: initialMusicVolume,
  adVolume: readVolume(AD_VOLUME_KEY, initialMusicVolume),
  volumeRevision: null,
}

musicVolumeInput.value = String(state.musicVolume)
adVolumeInput.value = String(state.adVolume)
setTheme(localStorage.getItem('cityshake-player-theme') === 'light')
document.querySelector('#light-theme-toggle').checked = document.documentElement.dataset.playerTheme === 'light'
document.querySelector('#autoplay-on-entry').checked = localStorage.getItem('cityshake-player-autoplay') === 'true'

loginForm.addEventListener('submit', login)
loginForm.hidden = true
playButton.addEventListener('click', togglePlayback)
document.querySelector('#logout-button').addEventListener('click', requestLogout)
document.querySelector('#restore-logout').addEventListener('click', requestLogout)
logoutCancelButton.addEventListener('click', () => logoutDialog.close())
logoutConfirmButton.addEventListener('click', async () => {
  logoutDialog.close()
  await logout()
})
if (!isAndroid) {
  document.addEventListener('pointerdown', (event) => {
    if (playerSettings.open && !playerSettings.contains(event.target)) playerSettings.open = false
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && playerSettings.open) playerSettings.open = false
  })
}
mobileNavigation.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mobile-screen]')
  if (!button || !isAndroid) return
  document.documentElement.dataset.mobileScreen = button.dataset.mobileScreen
  mobileNavigationButtons.forEach((item) => {
    if (item === button) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  window.scrollTo(0, 0)
})
document.querySelector('#retry-restore').addEventListener('click', restoreSavedAccount)
autostartToggle.addEventListener('change', updateAutostartSetting)
autostartEnableButton.addEventListener('click', enableAutostartFromPrompt)
autostartSkipButton.addEventListener('click', dismissAutostartPrompt)
autostartDialog.addEventListener('cancel', () => localStorage.setItem(AUTOSTART_ASKED_KEY, 'true'))
checkUpdatesButton.addEventListener('click', () => {
  playerSettings.open = false
  checkForUpdates(true)
})
updateLaterButton.addEventListener('click', () => updateDialog.close())
updateInstallButton.addEventListener('click', installAvailableUpdate)
document.querySelector('#light-theme-toggle').addEventListener('change', (event) => setTheme(event.currentTarget.checked))
document.querySelector('#autoplay-on-entry').addEventListener('change', (event) => {
  localStorage.setItem('cityshake-player-autoplay', String(event.currentTarget.checked))
})
musicVolumeInput.addEventListener('input', () => updateVolume('music', musicVolumeInput.value))
adVolumeInput.addEventListener('input', () => updateVolume('ad', adVolumeInput.value))
bindPlaybackEvents().catch((error) => showError(error))
initializeApp().catch((error) => showRestoreError(error))
window.setInterval(updateProgress, 500)

async function bindPlaybackEvents() {
  await listen('player-session-error', ({ payload }) => showError(payload))
  await listen('player-volume-updated', ({ payload }) => applyPlayerVolumeSettings(payload))
  if (isAndroid) {
    await addStateListener((nativeState) => {
      state.nativeCurrentTime = nativeState.currentTime
      state.nativeDuration = nativeState.duration
      if (nativeState.status === 'playing') setPlaybackState(true)
      if (nativeState.status === 'ended') handleTrackEnded()
      if (nativeState.status === 'error') showError(nativeState.error || 'Не удалось воспроизвести аудио.')
      updateProgress()
    })
    return
  }

  await listen('player-track-ended', () => handleTrackEnded())
  await listen('desktop-playback-progress', ({ payload }) => {
    state.nativeCurrentTime = payload.currentTime
    state.nativeDuration = payload.duration
    updateProgress()
  })
  await listen('player-playback-error', ({ payload }) => {
    state.startedAt = null
    setPlaybackState(false)
    showError(payload)
  })
  await listen('player-playback-recovered', () => {
    playerError.textContent = ''
    state.startedAt = Date.now()
    setPlaybackState(true)
  })
}

async function login(event) {
  event.preventDefault()
  hideFormError()
  if (!usernameInput.value.trim() || !passwordInput.value) {
    showFormError('Введите логин и пароль устройства.')
    return
  }

  setLoginBusy(true, 'Подключаемся…')
  try {
    const result = await invoke('native_login', {
      baseUrl: SERVICE_URL,
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    })
    if (isAndroid) {
      try {
        await invoke('plugin:native-audio|save_credentials', {
          username: usernameInput.value.trim(),
          password: passwordInput.value,
        })
      } catch (error) {
        await invoke('native_logout').catch(() => {})
        throw error
      }
    }
    passwordInput.value = ''
    await enterPlayer(result)
  } catch (error) {
    showFormError(errorText(error))
  } finally {
    setLoginBusy(false)
  }
}

async function initializeApp() {
  await restoreDesktopWindowSize().catch((error) => console.warn('Не удалось восстановить размер окна:', error))
  try {
    await initializeAutostartSetting()
  } catch {
    autostartSupported = false
    autostartSetting.hidden = true
  }
  await restoreSavedAccount()
  window.setTimeout(() => checkForUpdates(), 1200)
}

async function checkForUpdates(manual = false) {
  if (checkingForUpdates) return
  checkingForUpdates = true
  checkUpdatesButton.disabled = true
  if (manual) updateStatus.textContent = 'Проверяем…'

  try {
    if (isAndroid) {
      await checkAndroidRelease(manual)
    } else {
      await checkDesktopRelease(manual)
    }
  } catch (error) {
    console.warn('Не удалось проверить обновления Cityshake Player:', error)
    if (manual) updateStatus.textContent = 'Не удалось проверить обновления.'
  } finally {
    checkingForUpdates = false
    checkUpdatesButton.disabled = false
  }
}

async function checkDesktopRelease(manual) {
  const { check } = await import('@tauri-apps/plugin-updater')
  pendingDesktopUpdate = await check()
  pendingAndroidUpdate = null

  if (!pendingDesktopUpdate) {
    if (manual) updateStatus.textContent = 'Установлена последняя версия.'
    return
  }

  updateStatus.textContent = `Доступна версия ${pendingDesktopUpdate.version}.`
  await showUpdatePrompt({
    version: pendingDesktopUpdate.version,
    actionLabel: 'Установить',
  })
}

async function checkAndroidRelease(manual) {
  pendingDesktopUpdate = null
  pendingAndroidUpdate = null
  const response = await fetch('https://api.github.com/repos/ikstema/cs-music-player/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}`)

  const release = await response.json()
  const currentVersion = await getVersion()
  const apk = release.assets?.find((asset) => asset.name === 'cityshake-player-android-arm64.apk')
  if (!apk || !isVersionNewer(release.tag_name, currentVersion)) {
    if (manual) updateStatus.textContent = 'Установлена последняя версия.'
    return
  }

  const downloadUrl = new URL(apk.browser_download_url)
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com') {
    throw new Error('Ссылка на APK ведёт не на GitHub Releases')
  }

  pendingDesktopUpdate = null
  pendingAndroidUpdate = { version: release.tag_name, downloadUrl: downloadUrl.href }
  updateStatus.textContent = `Доступна версия ${release.tag_name}.`
  await showUpdatePrompt({ version: release.tag_name, actionLabel: 'Обновить' })
}

async function showUpdatePrompt({ version, actionLabel }) {
  if (autostartDialog.open) {
    await new Promise((resolve) => autostartDialog.addEventListener('close', resolve, { once: true }))
  }
  if (updateDialog.open) return

  updateMessage.textContent = `Доступна версия ${version}. Установить обновление сейчас?`
  updateInstallButton.textContent = actionLabel
  updateInstallButton.disabled = false
  updateDialog.showModal()
}

async function installAvailableUpdate() {
  updateInstallButton.disabled = true
  if (pendingAndroidUpdate) {
    updateInstallButton.textContent = 'Скачиваем обновление…'
    try {
      await invoke('plugin:native-audio|install_update', { url: pendingAndroidUpdate.downloadUrl })
      updateDialog.close()
      updateStatus.textContent = 'Подтвердите установку в системном окне Android.'
    } catch (error) {
      updateStatus.textContent = `Не удалось установить обновление: ${errorText(error)}`
      updateInstallButton.textContent = 'Повторить'
      updateInstallButton.disabled = false
    }
    return
  }

  if (!pendingDesktopUpdate) return
  updateInstallButton.textContent = 'Скачиваем обновление…'
  try {
    await pendingDesktopUpdate.downloadAndInstall()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    updateStatus.textContent = `Не удалось установить обновление: ${errorText(error)}`
    updateInstallButton.textContent = 'Повторить'
    updateInstallButton.disabled = false
  }
}

function isVersionNewer(candidate, current) {
  const parts = (value) => String(value).trim().replace(/^[vV]/, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const candidateParts = parts(candidate)
  const currentParts = parts(current)
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index]
  }
  return false
}

async function initializeAutostartSetting() {
  autostartSupported = await invoke('autostart_supported')
  autostartSetting.hidden = !autostartSupported
  if (autostartSupported) {
    autostartToggle.checked = await invoke('get_autostart_enabled')
  }
}

async function maybePromptAutostart() {
  if (!autostartSupported) return

  const enabled = await invoke('get_autostart_enabled')
  autostartToggle.checked = enabled
  if (enabled) {
    localStorage.setItem(AUTOSTART_ASKED_KEY, 'true')
    return
  }
  if (localStorage.getItem(AUTOSTART_ASKED_KEY) !== 'true' && !autostartDialog.open) {
    autostartDialog.showModal()
  }
}

async function updateAutostartSetting() {
  if (!autostartSupported) return
  const requested = autostartToggle.checked
  autostartToggle.disabled = true
  try {
    autostartToggle.checked = await invoke('set_autostart_enabled', { enabled: requested })
    if (autostartToggle.checked) localStorage.setItem(AUTOSTART_ASKED_KEY, 'true')
  } catch (error) {
    autostartToggle.checked = !requested
    showError(error)
  } finally {
    autostartToggle.disabled = false
  }
}

async function enableAutostartFromPrompt() {
  autostartEnableButton.disabled = true
  try {
    autostartToggle.checked = await invoke('set_autostart_enabled', { enabled: true })
    localStorage.setItem(AUTOSTART_ASKED_KEY, 'true')
    autostartDialog.close()
  } catch (error) {
    showError(error)
  } finally {
    autostartEnableButton.disabled = false
  }
}

function dismissAutostartPrompt() {
  localStorage.setItem(AUTOSTART_ASKED_KEY, 'true')
  autostartDialog.close()
}

async function restoreSavedAccount() {
  loginForm.hidden = true
  restoreActions.hidden = true
  loginCopy.textContent = 'Проверяем сохранённый вход…'

  try {
    let result
    if (isAndroid) {
      const saved = await invoke('plugin:native-audio|load_credentials')
      if (!saved?.hasCredentials) {
        showFreshLogin()
        return
      }
      result = await invoke('native_login', {
        baseUrl: SERVICE_URL,
        username: saved.username,
        password: saved.password,
      })
    } else {
      result = await invoke('restore_login', { baseUrl: SERVICE_URL })
      if (!result) {
        showFreshLogin()
        return
      }
    }

    await enterPlayer(result)
  } catch (error) {
    showRestoreError(error)
  }
}

function showFreshLogin() {
  loginCopy.textContent = 'Войдите с доступом, выданным администратором.'
  loginForm.hidden = false
  restoreActions.hidden = true
}

function showRestoreError(error) {
  loginCopy.textContent = 'Не удалось восстановить подключение к сохранённому аккаунту.'
  restoreMessage.textContent = errorText(error)
  restoreActions.hidden = false
  loginForm.hidden = true
}

async function enterPlayer(result) {
  const identity = normalizePlayerIdentity(result.player)
  state.player = { ...result.player, ...identity }
  state.volumeRevision = null
  persistInitialVolumeLevels()
  try {
    applyPlayerVolumeSettings(await invoke('get_player_volume'))
  } catch (error) {
    console.warn('Не удалось получить настройки громкости плеера:', error)
  }
  document.querySelector('#connection-label').textContent = [identity.client, identity.location, identity.name]
    .filter(Boolean)
    .join(' · ')
  document.querySelector('#footer-location').textContent = identity.location
  document.querySelector('#track-overline').textContent = `ВАШ ЭФИР · ${(identity.location || 'CITYSHAKE').toUpperCase()}`
  connectView.hidden = true
  playerView.hidden = false
  setTrack(null)
  setPlaybackState(false)
  try {
    await maybePromptAutostart()
  } catch (error) {
    showError(error)
  }
  if (document.querySelector('#autoplay-on-entry').checked) await startOrRetry()
}

function normalizePlayerIdentity(player) {
  const client = String(player?.client || '').trim()
  const rawLocation = String(player?.location || '').trim()
  const rawPlayer = String(player?.name || '').trim()
  return {
    client,
    location: removeIdentityPrefix(rawLocation, client),
    name: removeIdentityPrefix(rawPlayer, rawLocation),
  }
}

function removeIdentityPrefix(value, prefix) {
  if (!value || !prefix) return value
  const expected = `${prefix} · `
  return value.toLocaleLowerCase().startsWith(expected.toLocaleLowerCase())
    ? value.slice(expected.length).trim()
    : value
}

async function startOrRetry() {
  if (!state.player || isLoggingOut || state.isCompleting || playButton.disabled) return
  clearPlaybackRetry()
  playerError.textContent = ''
  setPlayBusy(true, 'Подготавливаем эфир…')
  try {
    if (isAndroid && !state.nativeReady) {
      await initialize()
      state.nativeReady = true
    }
    const result = await invoke('start_playback')
    if (!result.item) {
      if (isPlayerSessionBusy(result.message)) {
        schedulePlaybackRetry()
        return
      }
      clearPlaybackRetry(true)
      setTrack(null)
      setPlaybackState(false)
      showError(result.message || 'В плейлисте пока нет доступных треков.')
      return
    }
    clearPlaybackRetry(true)
    await playItem(result.item)
  } catch (error) {
    if (isPlayerSessionBusy(error)) schedulePlaybackRetry()
    else {
      clearPlaybackRetry(true)
      showError(error)
    }
  } finally {
    setPlayBusy(false)
  }
}

function isPlayerSessionBusy(error) {
  const message = errorText(error)
  return message.startsWith('__PLAYER_SESSION_BUSY__:')
    || /плеер.{0,80}(?:используется на другом устройстве|занят)|player.{0,80}(?:already in use|in use by another device)/i.test(message)
}

function clearPlaybackRetry(resetAttempt = false) {
  if (playbackRetryTimer !== null) {
    clearTimeout(playbackRetryTimer)
    playbackRetryTimer = null
  }
  if (resetAttempt) playbackRetryAttempt = 0
}

function schedulePlaybackRetry() {
  if (!state.player || isLoggingOut || playbackRetryTimer !== null) return
  const delayMs = Math.min(10_000, 2_000 + playbackRetryAttempt * 1_500)
  playbackRetryAttempt += 1
  playerError.textContent = 'Предыдущая сессия ещё завершается. Повторяем подключение…'
  playbackRetryTimer = window.setTimeout(() => {
    playbackRetryTimer = null
    if (state.player && !isLoggingOut && !state.isPlaying && !state.isCompleting) {
      void startOrRetry()
    }
  }, delayMs)
}

async function playItem(item) {
  state.currentItem = item
  state.elapsedBase = 0
  state.startedAt = null
  state.nativeCurrentTime = 0
  state.nativeDuration = 0
  setTrack(item)
  setPlaybackState(false, 'Загружаем аудио…')

  const volume = volumeForItem(item)
  if (isAndroid) {
    const cachedAudioUrl = await invoke('cache_audio_track', { audioUrl: item.audioUrl })
    await setSource({
      src: cachedAudioUrl,
      id: Date.now(),
      title: item.title,
      artist: item.artist || 'Cityshake Media',
      artworkUrl: item.coverUrl || undefined,
    })
    await invoke('plugin:native-audio|set_volume', { volume })
    await playNative()
  } else {
    await invoke('desktop_play', {
      audioUrl: item.audioUrl,
      volume,
      duration: Math.max(0, Math.floor(Number(item.duration) || 0)),
    })
  }
  state.startedAt = Date.now()
  setPlaybackState(true)
}

async function handleTrackEnded() {
  if (!state.currentItem || state.isCompleting) return
  state.isCompleting = true
  const finishedItem = state.currentItem
  state.elapsedBase = elapsedSeconds()
  state.startedAt = null
  try {
    const result = await invoke('complete_current', { eventId: finishedItem.id })
    addHistoryItem(finishedItem)
    if (result.item) {
      await playItem(result.item)
    } else {
      setTrack(null)
      setPlaybackState(false)
      showError(result.message || 'Плейлист закончился.')
    }
  } catch (error) {
    showError(error)
  } finally {
    state.isCompleting = false
  }
}

async function togglePlayback() {
  if (!state.currentItem) return startOrRetry()
  if (playButton.disabled) return
  playerError.textContent = ''
  setPlayBusy(true, state.isPlaying ? 'Приостанавливаем…' : 'Продолжаем…')
  try {
    if (state.isPlaying) {
      if (isAndroid) await pauseNative()
      else await invoke('desktop_pause')
      state.elapsedBase = elapsedSeconds()
      state.startedAt = null
      setPlaybackState(false)
    } else {
      if (isAndroid) await playNative()
      else await invoke('desktop_resume')
      state.startedAt = Date.now()
      setPlaybackState(true)
    }
  } catch (error) {
    showError(error)
  } finally {
    setPlayBusy(false)
  }
}

async function logout() {
  if (isLoggingOut) return
  isLoggingOut = true
  clearPlaybackRetry(true)
  if (volumeSyncTimer !== null) {
    clearTimeout(volumeSyncTimer)
    volumeSyncTimer = null
  }
  playerError.textContent = ''
  try {
    if (isAndroid) await invoke('plugin:native-audio|clear_credentials')
    else await invoke('clear_saved_credentials')
  } catch (error) {
    isLoggingOut = false
    showError(error)
    return
  }

  try {
    if (isAndroid && state.nativeReady) {
      await dispose()
      state.nativeReady = false
    } else if (!isAndroid) {
      await invoke('desktop_stop')
    }
    await invoke('native_logout')
  } catch (error) {
    showError(error)
  }
  state.player = null
  state.volumeRevision = null
  isLoggingOut = false
  state.history = []
  setTrack(null)
  renderHistory()
  playerView.hidden = true
  connectView.hidden = false
  restoreActions.hidden = true
  loginCopy.textContent = 'Войдите с доступом, выданным администратором.'
  loginForm.hidden = false
  passwordInput.value = ''
  usernameInput.focus()
}

function requestLogout() {
  if (!logoutDialog.open && !isLoggingOut) logoutDialog.showModal()
}

function setTrack(item) {
  state.currentItem = item
  state.nativeCurrentTime = 0
  state.nativeDuration = 0
  state.elapsedBase = 0
  state.startedAt = null
  document.querySelector('#track-title').textContent = item?.title || 'Готовы включить музыку?'
  document.querySelector('#track-artist').textContent = item
    ? item.kind === 'ad'
      ? `Рекламный ролик${item.rotation ? ` · ${item.rotation}` : ''}`
      : item.artist?.trim() || 'CITYSHAKE MEDIA'
    : 'Нажмите кнопку, чтобы начать воспроизведение'
  if (item && item.kind === 'ad') document.querySelector('#track-overline').textContent = 'РЕКЛАМНЫЙ БЛОК · СЕЙЧАС В ЭФИРЕ'
  else if (state.player) document.querySelector('#track-overline').textContent = `ВАШ ЭФИР · ${(state.player.location || 'CITYSHAKE').toUpperCase()}`

  const cover = document.querySelector('#album-cover')
  const fallback = document.querySelector('#cover-fallback')
  cover.querySelector('.cover-image')?.remove()
  fallback.hidden = false
  if (item?.coverUrl) {
    const image = document.createElement('img')
    image.className = 'cover-image'
    image.alt = ''
    image.src = item.coverUrl
    image.addEventListener('error', () => { image.remove(); fallback.hidden = false }, { once: true })
    cover.append(image)
    fallback.hidden = true
  }

  const duration = Number(item?.duration || 0)
  document.querySelector('#track-duration').textContent = duration > 0 ? formatTime(duration) : '--:--'
  document.querySelector('#elapsed-time').textContent = '00:00'
  document.querySelector('#progress-fill').style.width = '0%'
  updateProgress()
}

function setPlaybackState(isPlaying) {
  state.isPlaying = isPlaying
  const liveIndicator = document.querySelector('#live-indicator')
  const liveLabel = document.querySelector('#live-label')
  liveIndicator.classList.toggle('is-live', isPlaying)
  liveLabel.textContent = isPlaying ? 'В ЭФИРЕ' : state.currentItem ? 'НА ПАУЗЕ' : 'ГОТОВ К ЭФИРУ'
  document.querySelector('#play-icon').className = isPlaying ? 'pause-icon' : 'play-icon'
  playButton.setAttribute('aria-label', isPlaying ? 'Приостановить эфир' : state.currentItem ? 'Продолжить эфир' : 'Начать эфир')
  playLabel.textContent = isPlaying ? 'Приостановить эфир' : state.currentItem ? 'Продолжить эфир' : 'Начать эфир'
  playDescription.textContent = isPlaying
    ? 'Ваш эфир звучит'
    : state.currentItem
      ? 'Эфир приостановлен'
      : 'Воспроизведение по вашему плейлисту'
  updateProgress()
}

function setLoginBusy(isBusy, label = 'Войти в плеер') {
  submitButton.disabled = isBusy
  submitLabel.textContent = label
}

function setPlayBusy(isBusy, label) {
  playButton.disabled = isBusy
  if (isBusy && label) {
    playLabel.textContent = label
    playDescription.textContent = 'Пожалуйста, подождите'
  } else if (!isBusy) {
    setPlaybackState(state.isPlaying)
  }
}

function showFormError(message) {
  formError.textContent = message
  formError.hidden = false
}

function hideFormError() {
  formError.textContent = ''
  formError.hidden = true
}

function showError(error) {
  const message = errorText(error)
  if (connectView.hidden) playerError.textContent = message
  else showFormError(message)
}

function errorText(error) {
  return typeof error === 'string' ? error : error?.message || String(error)
}

function updateVolume(type, rawValue) {
  const volume = clamp(Number(rawValue))
  if (type === 'ad') {
    state.adVolume = volume
    localStorage.setItem(AD_VOLUME_KEY, String(volume))
    adVolumeSaved = true
  } else {
    state.musicVolume = volume
    localStorage.setItem(MUSIC_VOLUME_KEY, String(volume))
    if (!adVolumeSaved) {
      state.adVolume = volume
      adVolumeInput.value = String(volume)
    }
  }
  if (state.currentItem && (state.currentItem.kind === 'ad') === (type === 'ad')) {
    const command = isAndroid ? 'plugin:native-audio|set_volume' : 'desktop_set_volume'
    invoke(command, { volume }).catch(showError)
  }
  scheduleVolumeSync()
}

function scheduleVolumeSync() {
  if (!state.player) return
  if (volumeSyncTimer !== null) clearTimeout(volumeSyncTimer)
  volumeSyncTimer = window.setTimeout(async () => {
    volumeSyncTimer = null
    try {
      const settings = await invoke('set_player_volumes', {
        musicVolume: state.musicVolume,
        adVolume: state.adVolume,
      })
      state.volumeRevision = Number(settings.volumeRevision)
    } catch (error) {
      console.warn('Не удалось сохранить громкость плеера:', error)
    }
  }, 350)
}

function applyPlayerVolumeSettings(settings) {
  const musicVolume = Number(settings?.musicVolume)
  const adVolume = Number(settings?.adVolume)
  const revision = Number(settings?.volumeRevision)
  if (!Number.isFinite(musicVolume) || !Number.isFinite(adVolume)) return
  if (Number.isFinite(revision) && revision === state.volumeRevision) return

  state.musicVolume = clamp(musicVolume)
  state.adVolume = clamp(adVolume)
  state.volumeRevision = Number.isFinite(revision) ? revision : null
  adVolumeSaved = true
  musicVolumeInput.value = String(state.musicVolume)
  adVolumeInput.value = String(state.adVolume)
  localStorage.setItem(MUSIC_VOLUME_KEY, String(state.musicVolume))
  localStorage.setItem(AD_VOLUME_KEY, String(state.adVolume))

  if (state.currentItem) {
    const command = isAndroid ? 'plugin:native-audio|set_volume' : 'desktop_set_volume'
    invoke(command, { volume: volumeForItem(state.currentItem) }).catch(showError)
  }
}

async function restoreDesktopWindowSize() {
  if (isAndroid) return

  const appWindow = getCurrentWindow()
  const saved = localStorage.getItem(WINDOW_SIZE_KEY)
  if (saved) {
    try {
      const { width, height } = JSON.parse(saved)
      if (Number.isFinite(width) && Number.isFinite(height) && width >= 760 && height >= 760 && width <= 5000 && height <= 5000) {
        await appWindow.setSize(new LogicalSize(width, height))
      }
    } catch {
      localStorage.removeItem(WINDOW_SIZE_KEY)
    }
  }

  await appWindow.onResized(async ({ payload }) => {
    if (await appWindow.isMaximized()) return
    const scaleFactor = await appWindow.scaleFactor()
    const width = Math.round(payload.width / scaleFactor)
    const height = Math.round(payload.height / scaleFactor)
    if (width >= 760 && height >= 760) {
      localStorage.setItem(WINDOW_SIZE_KEY, JSON.stringify({ width, height }))
    }
  })
}

function volumeForItem(item) {
  return item?.kind === 'ad' ? state.adVolume : state.musicVolume
}

function addHistoryItem(item) {
  state.history.unshift({ ...item, finishedAt: new Date() })
  state.history = state.history.slice(0, 30)
  renderHistory()
}

function renderHistory() {
  historyList.replaceChildren()
  historyEmpty.hidden = state.history.length > 0
  if (!state.history.length) historyList.append(historyEmpty)
  document.querySelector('#history-count').textContent = `${state.history.length} треков`

  state.history.forEach((item, index) => {
    const row = document.createElement('div')
    row.className = 'history-row history-row-new'
    const number = document.createElement('span')
    number.className = 'history-number'
    number.textContent = String(state.history.length - index).padStart(2, '0')
    const art = document.createElement('div')
    art.className = 'history-art'
    if (item.coverUrl) {
      const image = document.createElement('img')
      image.src = item.coverUrl
      image.alt = ''
      art.append(image)
    } else {
      art.textContent = 'C.'
    }
    const details = document.createElement('div')
    details.className = 'history-details'
    const title = document.createElement('strong')
    title.textContent = item.title || 'Без названия'
    const artist = document.createElement('span')
    artist.textContent = item.kind === 'ad' ? 'Рекламный ролик' : item.artist || 'CITYSHAKE MEDIA'
    details.append(title, artist)
    const type = document.createElement('span')
    type.className = 'history-type'
    type.textContent = item.kind === 'ad' ? 'РЕКЛАМА' : 'МУЗЫКА'
    const time = document.createElement('span')
    time.className = 'history-time'
    time.textContent = item.finishedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    row.append(number, art, details, type, time)
    historyList.append(row)
  })
}

function updateProgress() {
  if (!state.currentItem) return
  const elapsed = Number.isFinite(state.nativeCurrentTime)
    ? Number(state.nativeCurrentTime)
    : elapsedSeconds()
  const duration = Math.max(
    Number(state.nativeDuration || state.currentItem.duration || 0),
    elapsed,
  )
  document.querySelector('#elapsed-time').textContent = formatTime(elapsed)
  if (duration > 0) {
    document.querySelector('#track-duration').textContent = formatTime(duration)
    document.querySelector('#progress-fill').style.width = `${Math.min(100, (elapsed / duration) * 100)}%`
  }
}

function elapsedSeconds() {
  if (Number.isFinite(state.nativeCurrentTime)) return Number(state.nativeCurrentTime)
  return state.elapsedBase + (state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0)
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function readVolume(key, fallback = 0.8) {
  const stored = localStorage.getItem(key)
  if (stored === null) return clamp(fallback)
  const saved = Number(stored)
  return Number.isFinite(saved) ? clamp(saved) : clamp(fallback)
}

function hasSavedVolume(key) {
  const stored = localStorage.getItem(key)
  return stored !== null && Number.isFinite(Number(stored))
}

function persistInitialVolumeLevels() {
  if (!hasSavedVolume(MUSIC_VOLUME_KEY)) {
    localStorage.setItem(MUSIC_VOLUME_KEY, String(state.musicVolume))
  }
  if (!adVolumeSaved) {
    state.adVolume = state.musicVolume
    adVolumeInput.value = String(state.adVolume)
    localStorage.setItem(AD_VOLUME_KEY, String(state.adVolume))
    adVolumeSaved = true
  }
}

function clamp(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.8))
}

function setTheme(isLight) {
  const theme = isLight ? 'light' : 'dark'
  document.documentElement.dataset.playerTheme = theme
  localStorage.setItem('cityshake-player-theme', theme)
  const themeToggle = document.querySelector('#light-theme-toggle')
  if (themeToggle) themeToggle.checked = isLight
}
