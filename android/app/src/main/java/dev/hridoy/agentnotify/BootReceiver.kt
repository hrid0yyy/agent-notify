package dev.hridoy.agentnotify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = Prefs(context)
        if (prefs.enabled && prefs.baseUrl.isNotBlank() && prefs.token.isNotBlank()) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, NotifyService::class.java),
            )
        }
    }
}
