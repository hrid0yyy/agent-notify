package dev.hridoy.agentnotify

import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

class NotifyService : Service() {
    companion object {
        const val ACTION_STOP = "dev.hridoy.agentnotify.STOP"
        const val ACTION_TEST = "dev.hridoy.agentnotify.TEST"
        const val SERVICE_NOTIFICATION_ID = 4101

        val status = MutableStateFlow("Not connected")
        val lastEvent = MutableStateFlow<String?>(null)

        @Volatile
        var running = false
            private set
    }

    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var stopping = false
    private var foregroundStarted = false
    private var attempt = 0
    private var activeAlarmId: String? = null

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== socket) return
            attempt = 0
            updateStatus("Connected")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== socket) return
            handleMessage(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket !== socket) return
            scheduleReconnect("Disconnected")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket !== socket) return
            scheduleReconnect("Offline")
        }
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        prefs = Prefs(this)
        Notifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat(status.value)

        if (intent?.action == ACTION_TEST) {
            Notifications.showTest(this)
        }

        if (!prefs.enabled) {
            stopSelf()
            return START_NOT_STICKY
        }

        connect()
        return START_STICKY
    }

    private fun startForegroundCompat(text: String) {
        val notification = buildServiceNotification(text)
        val type = if (Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(this, SERVICE_NOTIFICATION_ID, notification, type)
        foregroundStarted = true
    }

    private fun buildServiceNotification(text: String): android.app.Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, Notifications.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF7CE38B.toInt())
            .setContentTitle("Agent Notify")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateStatus(text: String) {
        status.value = text
        if (!foregroundStarted) return
        try {
            NotificationManagerCompat.from(this)
                .notify(SERVICE_NOTIFICATION_ID, buildServiceNotification(text))
        } catch (_: SecurityException) {
            // FGS notification permission can be revoked.
        }
    }

    private fun connect() {
        val url = prefs.wsUrl()
        val token = prefs.token
        if (url.isBlank() || token.isBlank()) {
            updateStatus("Add bridge URL and token")
            return
        }

        val previous = socket
        socket = null
        previous?.cancel()
        updateStatus("Connecting…")

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .build()

        socket = try {
            http.newWebSocket(request, listener)
        } catch (error: IllegalArgumentException) {
            updateStatus("Invalid bridge URL")
            null
        }
    }

    private fun scheduleReconnect(reason: String) {
        if (stopping || !prefs.enabled) return
        val delay = min(30_000L, 1_000L shl min(attempt, 5))
        attempt += 1
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({
            if (!stopping) connect()
        }, delay)
        updateStatus("$reason · retry in ${delay / 1000}s")
    }

    private fun closeAlarmScreen(askId: String) {
        sendBroadcast(
            Intent(AlarmActivity.ACTION_CLOSE_ALARM).apply {
                setPackage(packageName)
                putExtra(AlarmActivity.EXTRA_EVENT_ID, askId)
            },
        )
    }

    private fun handleMessage(text: String) {
        try {
            val message = JSONObject(text)
            when (message.optString("type")) {
                "event" -> {
                    val event = message.optJSONObject("event")?.let(EventParser::parse)
                    if (event != null) {
                        Notifications.showEvent(this, event)
                        val project = event.project.ifBlank { "unknown project" }
                        lastEvent.value =
                            "$project · ${Notifications.agentLabel(event.agent)}: ${event.title}"
                    }
                }

                "alarm" -> {
                    val eventJson = message.optJSONObject("event")?.toString()
                    val event = message.optJSONObject("event")?.let(EventParser::parse)
                    if (eventJson != null && event != null) {
                        activeAlarmId?.takeIf { it != event.id }?.let {
                            Notifications.cancelAlarm(this, it)
                        }
                        activeAlarmId = event.id
                        val ring = message.optInt("ring", 1)
                        val maxRings = message.optInt("maxRings", 3)
                        val duration = message.optLong("ringDurationSeconds", 45L)
                            .coerceIn(5L, 120L)
                        Notifications.showAlarm(this, eventJson, event, ring, maxRings)
                        Ringing.start(this, duration * 1000L)
                    }
                }

                "resolved", "cancelled" -> {
                    val askId = message.optString("askId")
                    if (askId.isNotBlank()) {
                        Notifications.cancel(this, askId)
                        Notifications.cancelAlarm(this, askId)
                        if (activeAlarmId == askId) {
                            activeAlarmId = null
                            Ringing.stop()
                            closeAlarmScreen(askId)
                        }
                    }
                }

                "snoozed", "stopped", "leaseEnded" -> {
                    val askId = message.optString("askId")
                    if (askId.isNotBlank()) {
                        Notifications.cancelAlarm(this, askId)
                        if (activeAlarmId == askId) {
                            activeAlarmId = null
                            Ringing.stop()
                            closeAlarmScreen(askId)
                        }
                    }
                }

                "presence" -> {
                    if (message.optString("mode") == "desk") {
                        activeAlarmId?.let { askId ->
                            Notifications.cancelAlarm(this, askId)
                            closeAlarmScreen(askId)
                        }
                        activeAlarmId = null
                        Ringing.stop()
                    }
                }

                "hello" -> updateStatus("Connected")
            }
        } catch (_: Exception) {
            // A malformed frame should not drop the connection.
        }
    }

    override fun onDestroy() {
        running = false
        stopping = true
        Ringing.stop()
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "service stopped")
        socket = null
        status.value = "Stopped"
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
