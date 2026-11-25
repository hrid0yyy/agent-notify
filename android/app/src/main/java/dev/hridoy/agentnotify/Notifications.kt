package dev.hridoy.agentnotify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat

object Notifications {
    const val CHANNEL_SERVICE = "agent_service"
    const val CHANNEL_DONE = "agent_done"
    const val CHANNEL_ATTENTION = "agent_attention"
    const val CHANNEL_ALARM = "agent_alarm"
    const val GROUP = "agent_notify_events"
    const val KEY_REPLY_TEXT = "reply_text"

    fun agentLabel(agent: String): String = when (agent) {
        "claude-code" -> "Claude Code"
        "opencode" -> "OpenCode"
        "mcp" -> "MCP"
        "test" -> "Test"
        else -> agent.replace('-', ' ')
            .replaceFirstChar { it.uppercase() }
            .ifBlank { "Agent" }
    }

    private fun agentColor(agent: String): Int = when (agent) {
        "claude-code" -> 0xFFD97757.toInt()
        "opencode" -> 0xFF7CE38B.toInt()
        "mcp" -> 0xFF8AB4F8.toInt()
        else -> 0xFF7CE38B.toInt()
    }

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val service = NotificationChannel(
            CHANNEL_SERVICE,
            "Background connection",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the Tailscale connection to your agent machine open."
            setShowBadge(false)
            setSound(null, null)
        }
        val done = NotificationChannel(
            CHANNEL_DONE,
            "Agent finished",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "A coding agent finished a task."
            enableVibration(false)
        }
        val attention = NotificationChannel(
            CHANNEL_ATTENTION,
            "Agent needs you",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Permission requests and questions from your coding agent."
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 180, 90, 180)
        }
        val alarm = NotificationChannel(
            CHANNEL_ALARM,
            "Urgent agent alarms",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Wake-up alarms for unanswered agent approval requests."
            setSound(null, null)
            enableVibration(false)
            setShowBadge(true)
            try {
                setBypassDnd(true)
            } catch (_: SecurityException) {
                // Do Not Disturb access is optional; the alarm still rings.
            }
        }
        manager.createNotificationChannels(listOf(service, done, attention, alarm))
    }

    fun showEvent(context: Context, event: AgentEvent) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val channel = if (event.attention) CHANNEL_ATTENTION else CHANNEL_DONE
        val agent = agentLabel(event.agent)
        val project = event.project.ifBlank { "unknown project" }
        val title = if (event.project.isBlank()) event.title else "$project · ${event.title}"
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(agentColor(event.agent))
            .setContentTitle(title)
            .setContentText(event.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body))
            .setSubText(agent)
            .setPriority(
                if (event.attention) NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT
            )
            .setCategory(
                if (event.attention) NotificationCompat.CATEGORY_MESSAGE
                else NotificationCompat.CATEGORY_STATUS
            )
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(GROUP)
            .setAutoCancel(true)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        builder.setContentIntent(
            PendingIntent.getActivity(
                context,
                event.id.hashCode(),
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )

        event.options.forEach { option ->
            val actionIntent = Intent(context, ActionReceiver::class.java).apply {
                action = ActionReceiver.ACTION_RESPOND
                putExtra(ActionReceiver.EXTRA_EVENT_ID, event.id)
                putExtra(ActionReceiver.EXTRA_ACTION, option.id)
            }
            val pending = PendingIntent.getBroadcast(
                context,
                (event.id + option.id).hashCode(),
                actionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(0, option.label, pending).build(),
            )
        }

        if (event.allowText && event.askId != null) {
            val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT)
                .setLabel("Reply to the agent…")
                .build()
            val replyIntent = Intent(context, ActionReceiver::class.java).apply {
                action = ActionReceiver.ACTION_REPLY
                putExtra(ActionReceiver.EXTRA_EVENT_ID, event.id)
                putExtra(ActionReceiver.EXTRA_ACTION, "reply")
            }
            val pending = PendingIntent.getBroadcast(
                context,
                (event.id + "reply").hashCode(),
                replyIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(0, "Reply", pending)
                    .addRemoteInput(remoteInput)
                    .build(),
            )
        }

        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(agentColor(event.agent))
            .setContentTitle(title)
            .setContentText("$agent · unlock to view")
            .setSubText(agent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        builder.setPublicVersion(publicVersion)

        try {
            NotificationManagerCompat.from(context).notify(event.id.hashCode(), builder.build())
        } catch (_: SecurityException) {
            // Notification permission was revoked between the check and the call.
        }
    }

    private fun alarmId(eventId: String): Int = eventId.hashCode() xor 0x5A5A5A5A

    fun showAlarm(
        context: Context,
        eventJson: String,
        event: AgentEvent,
        ring: Int,
        maxRings: Int,
    ) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannels(context)
        val agent = agentLabel(event.agent)
        val project = event.project.ifBlank { "unknown project" }
        val open = PendingIntent.getActivity(
            context,
            (event.id + "alarm").hashCode(),
            Intent(context, AlarmActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(AlarmActivity.EXTRA_EVENT_JSON, eventJson)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val snooze = PendingIntent.getBroadcast(
            context,
            (event.id + "snooze").hashCode(),
            Intent(context, ActionReceiver::class.java).apply {
                action = ActionReceiver.ACTION_SNOOZE
                putExtra(ActionReceiver.EXTRA_EVENT_ID, event.id)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getBroadcast(
            context,
            (event.id + "stop").hashCode(),
            Intent(context, ActionReceiver::class.java).apply {
                action = ActionReceiver.ACTION_STOP
                putExtra(ActionReceiver.EXTRA_EVENT_ID, event.id)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ALARM)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(agentColor(event.agent))
            .setContentTitle("URGENT · $project")
            .setContentText("$agent needs an answer")
            .setSubText("$agent · ring $ring/$maxRings")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(open, true)
            .setContentIntent(open)
            .addAction(0, "Snooze 5 min", snooze)
            .addAction(0, "Stop", stop)

        try {
            NotificationManagerCompat.from(context).notify(alarmId(event.id), builder.build())
        } catch (_: SecurityException) {
            // Audio still rings from the service if notifications are blocked.
        }
    }

    fun cancelAlarm(context: Context, eventId: String) {
        NotificationManagerCompat.from(context).cancel(alarmId(eventId))
    }

    fun showTest(context: Context) {
        ensureChannels(context)
        showEvent(
            context,
            AgentEvent(
                id = "test_${System.currentTimeMillis()}",
                kind = "done",
                title = "Test notification",
                body = "If this is on your phone, the app can post notifications. Use the CLI for an end-to-end test.",
                agent = "agent-notify",
                project = "test",
                askId = null,
                options = emptyList(),
                allowText = false,
            ),
        )
    }

    fun cancel(context: Context, eventId: String) {
        NotificationManagerCompat.from(context).cancel(eventId.hashCode())
    }
}
