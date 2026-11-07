# Cityshake Player Client

Tauri 2 client for macOS, Windows and Android. It has a local sign-in and player UI and uses the existing Django service for device leases, playlists, audio streaming and playback history.

Playback uses Rodio/CPAL for native desktop audio and Android Media3 through `tauri-plugin-native-audio`. On Android, Media3 provides a media session, notification controls and foreground playback. Android's minimum supported version is API 26.

## Run on desktop

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system, then:

```sh
npm install
npm run tauri:dev
```

## Initialize Android

Install Android Studio and the Android SDK, set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, and add the Android targets to Rust. Then run:

```sh
npm install
npm run android:init
npm run android:dev
```

For an Android build, run `npm run android:build`. The generated Android project is kept under `src-tauri/gen/android`; release APKs are written to `src-tauri/gen/android/app/build/outputs/apk`. The GitHub release workflow signs the distributable APK with the repository's Android release keystore. The debug APK is signed with the Android debug key and cannot update a release-signed install.

## Connect to a service

The client connects to `https://player.cityshake.media`; the server address is built into the app. Sign in with the device player's credentials. Desktop credentials use the operating system credential store; Android credentials are encrypted with Android Keystore. They are removed when the user logs out.

The server must have the native login/logout endpoints deployed. Audio URLs for native clients are short-lived signed links tied to the active device lease and queued track. Deploy the corresponding Django changes before distributing the client to users.

The same web player stylesheet is shared with the native UI. The release workflow runs when a `vX.Y.Z` tag is pushed. It builds macOS Apple Silicon and Intel bundles, Windows installers, and a signed Android arm64 APK, then publishes them as a GitHub Release. Keep the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in sync with the tag.

macOS and Windows check GitHub Releases for signed updates when the app starts and from Settings. The app asks before downloading and installing. Android checks the latest release and opens the APK download after confirmation; Android then shows its own install confirmation and may ask the user to allow installs from the browser.

The release workflow uses these repository Actions secrets: `TAURI_SIGNING_PRIVATE_KEY`, `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The private signing keys are long-lived: keep the local backups outside source control and do not replace them after distributing releases. macOS builds use an ad-hoc signature because no Apple Developer certificate is configured; macOS may require approval in Privacy & Security before the first launch.
