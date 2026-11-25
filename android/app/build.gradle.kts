import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val agentNotifyVersionName =
    providers.gradleProperty("agentNotifyVersionName").orElse("1.0.0").get()
val agentNotifyVersionCode =
    providers.gradleProperty("agentNotifyVersionCode").orElse("10000").get().toInt()

android {
    namespace = "dev.hridoy.agentnotify"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.hridoy.agentnotify"
        minSdk = 26
        targetSdk = 36
        versionCode = agentNotifyVersionCode
        versionName = agentNotifyVersionName
    }

    signingConfigs {
        val keystorePath = System.getenv("AGENT_NOTIFY_KEYSTORE")
        if (!keystorePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("AGENT_NOTIFY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AGENT_NOTIFY_KEY_ALIAS")
                keyPassword = System.getenv("AGENT_NOTIFY_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
