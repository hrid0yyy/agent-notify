package dev.hridoy.agentnotify

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("agent_notify", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = sp.getString("base_url", "") ?: ""
        set(value) {
            sp.edit().putString("base_url", value.trim()).apply()
        }

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(value) {
            sp.edit().putString("token", value.trim()).apply()
        }

    var enabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(value) {
            sp.edit().putBoolean("enabled", value).apply()
        }

    fun wsUrl(): String {
        var base = normalizedBase()
        if (base.isEmpty()) return ""
        base = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        return if (base.endsWith("/ws")) base else "$base/ws"
    }

    fun httpBase(): String {
        var base = normalizedBase()
        if (base.isEmpty()) return ""
        base = base.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
        if (base.endsWith("/ws")) base = base.dropLast(3)
        return base.trimEnd('/')
    }

    private fun normalizedBase(): String {
        var base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) return ""
        if (!base.startsWith("http://") &&
            !base.startsWith("https://") &&
            !base.startsWith("ws://") &&
            !base.startsWith("wss://")
        ) {
            base = "https://$base"
        }
        return base
    }
}
