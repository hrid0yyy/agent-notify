package dev.hridoy.agentnotify

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * One looping alarm at a time. Used by both the foreground service (so it rings
 * even if the full-screen activity is blocked) and the alarm activity.
 */
object Ringing {
    private val handler = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var stopRunnable: Runnable? = null

    @Synchronized
    fun start(context: Context, durationMs: Long = 45_000L) {
        if (player != null) return
        val app = context.applicationContext

        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            if (uri != null) {
                player = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    setDataSource(app, uri)
                    isLooping = true
                    prepare()
                    start()
                }
            }
        } catch (_: Exception) {
            player?.release()
            player = null
        }

        try {
            vibrator = if (Build.VERSION.SDK_INT >= 31) {
                app.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                app.getSystemService(Vibrator::class.java)
            }
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator?.vibrate(
                    VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0),
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(longArrayOf(0, 600, 400), 0)
            }
        } catch (_: Exception) {
            vibrator = null
        }

        stopRunnable?.let { handler.removeCallbacks(it) }
        stopRunnable = Runnable { stop() }
        handler.postDelayed(stopRunnable!!, durationMs)
    }

    @Synchronized
    fun stop() {
        stopRunnable?.let { handler.removeCallbacks(it) }
        stopRunnable = null
        try {
            player?.stop()
        } catch (_: Exception) {
        }
        try {
            player?.release()
        } catch (_: Exception) {
        }
        player = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
        vibrator = null
    }
}
