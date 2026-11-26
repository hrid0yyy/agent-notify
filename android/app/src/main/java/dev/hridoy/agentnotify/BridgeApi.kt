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
        execute(context, "POST", path, body) { ok, _ ->
            onResult?.invoke(ok)
        }
    }

    fun getJson(
        context: Context,
        path: String,
        onResult: (JSONObject?) -> Unit,
    ) {
        execute(context, "GET", path, null) { _, value ->
            onResult(value)
        }
    }

    fun postJson(
        context: Context,
        path: String,
        body: JSONObject = JSONObject(),
        onResult: (JSONObject?) -> Unit,
    ) {
        execute(context, "POST", path, body) { _, value ->
            onResult(value)
        }
    }

    fun deleteJson(
        context: Context,
        path: String,
        onResult: (JSONObject?) -> Unit,
    ) {
        execute(context, "DELETE", path, null) { _, value ->
            onResult(value)
        }
    }

    private fun execute(
        context: Context,
        method: String,
        path: String,
        body: JSONObject?,
        onResult: (Boolean, JSONObject?) -> Unit,
    ) {
        Thread {
            var ok = false
            var value: JSONObject? = null
            try {
                val prefs = Prefs(context)
                val base = prefs.httpBase()
                if (base.isNotBlank() && prefs.token.isNotBlank()) {
                    val builder = Request.Builder()
                        .url(base + path)
                        .header("Authorization", "Bearer ${prefs.token}")
                    if (method == "GET") {
                        builder.get()
                    } else if (method == "DELETE") {
                        builder.delete()
                    } else {
                        builder.post((body ?: JSONObject()).toString().toRequestBody(json))
                    }
                    client.newCall(builder.build()).execute().use { response ->
                        ok = response.isSuccessful
                        val text = response.body?.string().orEmpty()
                        if (text.isNotBlank()) {
                            value = try {
                                JSONObject(text)
                            } catch (_: Exception) {
                                null
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                ok = false
                value = null
            }
            Handler(Looper.getMainLooper()).post {
                onResult(ok, value)
            }
        }.start()
    }
}
