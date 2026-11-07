package app.tauri.nativeaudio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class StoredCredentials(val username: String, val password: String)

object NativeCredentialStore {
    private const val KEY_ALIAS = "cityshake-player-credentials"
    private const val PREFERENCES_NAME = "cityshake_secure_credentials"
    private const val CREDENTIALS_KEY = "encrypted_credentials"
    private const val IV_LENGTH = 12

    fun save(context: Context, username: String, password: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val cleartext = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val encrypted = cipher.doFinal(cleartext)
        val packed = cipher.iv + encrypted
        val encoded = Base64.encodeToString(packed, Base64.NO_WRAP)
        val saved = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(CREDENTIALS_KEY, encoded)
            .commit()
        check(saved) { "Не удалось сохранить данные входа на устройстве." }
    }

    fun load(context: Context): StoredCredentials? {
        val encoded = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getString(CREDENTIALS_KEY, null) ?: return null
        val packed = Base64.decode(encoded, Base64.NO_WRAP)
        require(packed.size > IV_LENGTH) { "Сохранённые данные входа повреждены." }

        val iv = packed.copyOfRange(0, IV_LENGTH)
        val encrypted = packed.copyOfRange(IV_LENGTH, packed.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        val cleartext = String(cipher.doFinal(encrypted), Charsets.UTF_8)
        val json = JSONObject(cleartext)
        val username = json.optString("username")
        val password = json.optString("password")
        require(username.isNotBlank() && password.isNotEmpty()) { "Сохранённые данные входа повреждены." }
        return StoredCredentials(username, password)
    }

    fun clear(context: Context) {
        val cleared = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(CREDENTIALS_KEY)
            .commit()
        check(cleared) { "Не удалось удалить сохранённые данные входа." }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }
}
