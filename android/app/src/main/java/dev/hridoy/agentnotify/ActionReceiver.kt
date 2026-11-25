package dev.hridoy.agentnotify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

class ActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_RESPOND = "dev.hridoy.agentnotify.RESPOND"
        const val ACTION_REPLY = "dev.hridoy.agentnotify.REPLY"
        const val ACTION_SNOOZE = "dev.hridoy.agentnotify.SNOOZE"
        const val ACTION_STOP = "dev.hridoy.agentnotify.STOP"
        const val EXTRA_EVENT_ID = "event_id"
        const val EXTRA_ACTION = "action"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
        val pending = goAsync()

        when (intent.action) {
            ACTION_SNOOZE -> {
                BridgeApi.post(
                    context,
                    "/snooze/$eventId",
                    JSONObject().put("minutes", 5),
                ) {
                    Ringing.stop()
                    Notifications.cancelAlarm(context, eventId)
                    closeAlarmScreen(context, eventId)
                    pending.finish()
                }
            }

            ACTION_STOP -> {
                BridgeApi.post(context, "/stop/$eventId", JSONObject()) {
                    Ringing.stop()
                    Notifications.cancelAlarm(context, eventId)
                    closeAlarmScreen(context, eventId)
                    pending.finish()
                }
            }

            else -> {
                val action = intent.getStringExtra(EXTRA_ACTION) ?: "reply"
                val reply = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(Notifications.KEY_REPLY_TEXT)
                    ?.toString()
                val body = JSONObject()
                    .put("action", action)
                    .put("text", reply ?: "")
                BridgeApi.post(context, "/respond/$eventId", body) {
                    Notifications.cancelAlarm(context, eventId)
                    NotificationManagerCompat.from(context).cancel(eventId.hashCode())
                    // The service closes/stops the alarm only if this event owns it.
                    pending.finish()
                }
            }
        }
    }

    private fun closeAlarmScreen(context: Context, eventId: String) {
        context.sendBroadcast(
            Intent(AlarmActivity.ACTION_CLOSE_ALARM).apply {
                setPackage(context.packageName)
                putExtra(AlarmActivity.EXTRA_EVENT_ID, eventId)
            },
        )
    }
}
