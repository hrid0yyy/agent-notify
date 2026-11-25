package dev.hridoy.agentnotify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import dev.hridoy.agentnotify.ui.theme.AgentNotifyTheme
import org.json.JSONObject

class AlarmActivity : ComponentActivity() {
    companion object {
        const val EXTRA_EVENT_JSON = "event_json"
        const val EXTRA_EVENT_ID = "event_id"
        const val ACTION_CLOSE_ALARM = "dev.hridoy.agentnotify.CLOSE_ALARM"
    }

    private var event: AgentEvent? = null

    private val closeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val askId = intent?.getStringExtra(EXTRA_EVENT_ID)
            if (askId == null || askId == event?.id) {
                Ringing.stop()
                event?.let { Notifications.cancelAlarm(this@AlarmActivity, it.id) }
                finishAndRemoveTask()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ContextCompat.registerReceiver(
            this,
            closeReceiver,
            IntentFilter(ACTION_CLOSE_ALARM),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    // An alarm should be answered, snoozed, or stopped explicitly.
                }
            },
        )

        val parsed = parseIntent(intent)
        if (parsed == null) {
            finish()
            return
        }
        show(parsed)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        parseIntent(intent)?.let(::show)
    }

    private fun show(parsed: AgentEvent) {
        event = parsed
        Ringing.start(this)
        setContent {
            AgentNotifyTheme {
                AlarmScreen(
                    event = parsed,
                    onOption = { option -> answer(parsed, option) },
                    onReply = { text -> reply(parsed, text) },
                    onSnooze = { snooze(parsed) },
                    onStop = { stopAlarm(parsed) },
                )
            }
        }
    }

    private fun parseIntent(intent: Intent?): AgentEvent? {
        val raw = intent?.getStringExtra(EXTRA_EVENT_JSON) ?: return null
        return try {
            EventParser.parse(JSONObject(raw))
        } catch (_: Exception) {
            null
        }
    }

    private fun answer(event: AgentEvent, option: EventOption) {
        closeAlarm(event, cancelOriginal = true)
        BridgeApi.post(
            this,
            "/respond/${event.id}",
            JSONObject().put("action", option.id).put("text", ""),
        )
    }

    private fun reply(event: AgentEvent, text: String) {
        if (text.isBlank()) {
            Toast.makeText(this, "Type a reply first.", Toast.LENGTH_SHORT).show()
            return
        }
        closeAlarm(event, cancelOriginal = true)
        BridgeApi.post(
            this,
            "/respond/${event.id}",
            JSONObject().put("action", "reply").put("text", text),
        )
    }

    private fun snooze(event: AgentEvent) {
        closeAlarm(event, cancelOriginal = false)
        BridgeApi.post(
            this,
            "/snooze/${event.id}",
            JSONObject().put("minutes", 5),
        )
    }

    private fun stopAlarm(event: AgentEvent) {
        closeAlarm(event, cancelOriginal = false)
        BridgeApi.post(this, "/stop/${event.id}", JSONObject())
    }

    private fun closeAlarm(event: AgentEvent, cancelOriginal: Boolean) {
        Ringing.stop()
        Notifications.cancelAlarm(this, event.id)
        if (cancelOriginal) Notifications.cancel(this, event.id)
        finishAndRemoveTask()
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(closeReceiver)
        } catch (_: IllegalArgumentException) {
            // Already unregistered.
        }
        Ringing.stop()
        super.onDestroy()
    }
}

@Composable
private fun AlarmScreen(
    event: AgentEvent,
    onOption: (EventOption) -> Unit,
    onReply: (String) -> Unit,
    onSnooze: () -> Unit,
    onStop: () -> Unit,
) {
    var reply by remember { mutableStateOf("") }
    val agent = Notifications.agentLabel(event.agent)
    val project = event.project.ifBlank { "unknown project" }
    val danger = Color(0xFFFF6B6B)

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color(0xFF140A0A),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 22.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .background(danger, CircleShape),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "URGENT",
                    color = danger,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
            }

            Text(
                text = "$agent · $project",
                color = Color(0xFFD7B8B8),
                style = MaterialTheme.typography.bodyMedium,
            )

            Text(
                text = event.title,
                color = Color(0xFFF5EAEA),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
            )

            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF241515),
                shape = RoundedCornerShape(16.dp),
            ) {
                Text(
                    text = event.body,
                    modifier = Modifier.padding(16.dp),
                    color = Color(0xFFF0E4E4),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            event.options.forEach { option ->
                Button(
                    onClick = { onOption(option) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(54.dp),
                    colors = if (option.destructive) {
                        ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF8B1A1A),
                            contentColor = Color.White,
                        )
                    } else {
                        ButtonDefaults.buttonColors()
                    },
                ) {
                    Text(option.label, fontWeight = FontWeight.SemiBold)
                }
            }

            if (event.allowText) {
                OutlinedTextField(
                    value = reply,
                    onValueChange = { reply = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Reply to the agent") },
                    minLines = 2,
                )
                Button(
                    onClick = { onReply(reply) },
                    enabled = reply.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Send reply")
                }
            }

            Spacer(Modifier.height(4.dp))

            OutlinedButton(
                onClick = onSnooze,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Snooze 5 minutes")
            }
            TextButton(
                onClick = onStop,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Stop alarming", color = Color(0xFFD7B8B8))
            }
        }
    }
}
