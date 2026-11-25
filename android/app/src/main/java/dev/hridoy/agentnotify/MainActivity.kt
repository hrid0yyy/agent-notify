package dev.hridoy.agentnotify

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.hridoy.agentnotify.ui.theme.AgentNotifyTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applySetupIntent(intent)
        val prefs = Prefs(this)
        if (prefs.enabled && !NotifyService.running) {
            ContextCompat.startForegroundService(
                this,
                Intent(this, NotifyService::class.java),
            )
        }
        setContent {
            AgentNotifyTheme {
                AgentNotifyScreen(prefs)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (applySetupIntent(intent)) {
            recreate()
        }
    }

    private fun applySetupIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "agentnotify" || data.host != "setup") return false
        val url = data.getQueryParameter("url")?.trim().orEmpty()
        val token = data.getQueryParameter("token")?.trim().orEmpty()
        if (url.isBlank() || token.isBlank()) return false
        val prefs = Prefs(this)
        prefs.baseUrl = url
        prefs.token = token
        prefs.enabled = true
        Toast.makeText(this, "Agent Notify configured", Toast.LENGTH_SHORT).show()
        return true
    }
}

@Composable
private fun AgentNotifyScreen(prefs: Prefs) {
    val context = LocalContext.current
    var baseUrl by remember { mutableStateOf(prefs.baseUrl) }
    var token by remember { mutableStateOf(prefs.token) }
    var enabled by remember { mutableStateOf(prefs.enabled) }
    var showToken by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    val status by NotifyService.status.collectAsStateWithLifecycle()
    val lastEvent by NotifyService.lastEvent.collectAsStateWithLifecycle()
    val notificationManager = context.getSystemService(NotificationManager::class.java)
    val fullScreenAllowed =
        Build.VERSION.SDK_INT < 34 || notificationManager?.canUseFullScreenIntent() == true

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!granted) hint = "Notifications are blocked. Allow them in Android settings."
    }

    fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun saveAndConnect() {
        prefs.baseUrl = baseUrl
        prefs.token = token
        prefs.enabled = enabled
        if (!enabled) {
            context.stopService(Intent(context, NotifyService::class.java))
            hint = "Background service stopped."
            return
        }
        requestNotificationPermissionIfNeeded()
        ContextCompat.startForegroundService(
            context,
            Intent(context, NotifyService::class.java),
        )
        hint = "Connecting to ${prefs.httpBase().ifBlank { "the bridge" }}…"
    }

    fun testNotification() {
        requestNotificationPermissionIfNeeded()
        Notifications.showTest(context)
        hint = "Local test posted. Use `npm run test:event` to test the bridge."
    }

    fun fullScreenAlarmSettings() {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:${context.packageName}"),
                    ),
                )
            } catch (_: Exception) {
                hint = "Open Settings → Special app access → Full-screen notifications."
            }
        } else {
            hint = "Full-screen alarms are allowed by default on this Android version."
        }
    }

    fun batterySettings() {
        val power = context.getSystemService(PowerManager::class.java)
        if (power?.isIgnoringBatteryOptimizations(context.packageName) == true) {
            hint = "Battery optimization is already disabled for this app."
            return
        }
        try {
            context.startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ),
            )
        } catch (_: Exception) {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Agent Notify",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Task completion and approvals from Claude Code and OpenCode, delivered over your tailnet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            StatusCard(status)

            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Bridge URL") },
                placeholder = { Text("https://host.tailnet.ts.net") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )

            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Token") },
                singleLine = true,
                visualTransformation = if (showToken) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                trailingIcon = {
                    TextButton(onClick = { showToken = !showToken }) {
                        Text(if (showToken) "Hide" else "Show")
                    }
                },
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Run in background", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Uses a foreground service so Android does not freeze the connection.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(checked = enabled, onCheckedChange = { enabled = it })
            }

            Button(
                onClick = { saveAndConnect() },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (enabled) "Save & connect" else "Save")
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { testNotification() },
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Test")
                }
                OutlinedButton(
                    onClick = { batterySettings() },
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Battery")
                }
            }

            OutlinedButton(
                onClick = { fullScreenAlarmSettings() },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (fullScreenAllowed) {
                        "Full-screen alarms: allowed"
                    } else {
                        "Allow full-screen alarms"
                    },
                )
            }

            hint?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            SetupCard()

            lastEvent?.let {
                Text(
                    text = "Last event: $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                text = "v${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun StatusCard(status: String) {
    val connected = status.startsWith("Connected")
    val dot = if (connected) Color(0xFF7CE38B) else Color(0xFFF2B84B)
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(18.dp),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .background(dot, CircleShape),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    text = "Connection",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
    }
}

@Composable
private fun SetupCard() {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(18.dp),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Setup", style = MaterialTheme.typography.titleMedium)
            Text(
                "1. On the agent machine, expose the bridge on your tailnet:",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Mono("tailscale serve --bg 8787")
            Text(
                "2. Start the bridge and keep it running:",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Mono("npm run bridge")
            Text(
                "3. Paste the printed https://…ts.net URL and token above.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "4. Allow notifications, then disable battery optimization for this app.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "5. Allow full-screen alarms so an unanswered request can wake the phone.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Mono(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceVariant,
                RoundedCornerShape(10.dp),
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}
