package dev.hridoy.agentnotify

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object BridgeApi {
    private val json = "application/json".toMediaType()
    private val client by lazy {
        OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    fun post(
        context: Context,
        path: String,
        body: JSONObject = JSONObject(),
        onResult: ((Boolean) -> Unit)? = null,
    ) {
        Thread {
            var ok = false
            try {
                val prefs = Prefs(context)
                val base = prefs.httpBase()
                if (base.isNotBlank() && prefs.token.isNotBlank()) {
                    val request = Request.Builder()
                        .url(base + path)
                        .header("Authorization", "Bearer ${prefs.token}")
                        .post(body.toString().toRequestBody(json))
                        .build()
                    client.newCall(request).execute().use { ok = it.isSuccessful }
                }
            } catch (_: Exception) {
                ok = false
            }
            onResult?.let { callback ->
                Handler(Looper.getMainLooper()).post { callback(ok) }
            }
        }.start()
    }
}
