package dev.hridoy.agentnotify

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
    }
}
