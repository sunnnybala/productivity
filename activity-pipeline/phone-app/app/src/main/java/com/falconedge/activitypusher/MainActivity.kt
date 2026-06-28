package com.falconedge.activitypusher

import android.app.Activity
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * Setup screen: paste Supabase URL + anon key, grant Usage Access, test upload.
 * Saving also schedules the once-daily WorkManager job.
 */
class MainActivity : Activity() {

    private lateinit var urlField: EditText
    private lateinit var keyField: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        urlField = findViewById(R.id.urlField)
        keyField = findViewById(R.id.keyField)
        status = findViewById(R.id.statusView)

        val prefs = getSharedPreferences(Prefs.NAME, Context.MODE_PRIVATE)
        urlField.setText(prefs.getString(Prefs.URL, ""))
        keyField.setText(prefs.getString(Prefs.KEY, ""))

        findViewById<Button>(R.id.saveBtn).setOnClickListener {
            prefs.edit()
                .putString(Prefs.URL, urlField.text.toString().trim())
                .putString(Prefs.KEY, keyField.text.toString().trim())
                .apply()
            scheduleDaily()
            setStatus("Saved. Daily upload scheduled.\nUsage access: ${if (hasUsageAccess()) "GRANTED" else "NOT granted"}")
        }

        findViewById<Button>(R.id.permBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }

        findViewById<Button>(R.id.runBtn).setOnClickListener { uploadNow() }

        setStatus(initialStatus(prefs))
    }

    private fun initialStatus(prefs: android.content.SharedPreferences): String {
        val access = if (hasUsageAccess()) "GRANTED" else "NOT granted — tap Grant Usage Access"
        val last = prefs.getString(Prefs.LAST_STATUS, null)
        return if (last != null) "Usage access: $access\nLast run: $last" else "Usage access: $access"
    }

    private fun uploadNow() {
        setStatus("Uploading...")
        Thread {
            val msg = try {
                if (!hasUsageAccess()) {
                    "Usage access NOT granted — tap Grant Usage Access first."
                } else {
                    val url = urlField.text.toString().trim()
                    val key = keyField.text.toString().trim()
                    if (url.isEmpty() || key.isEmpty()) {
                        "Enter Supabase URL and anon key first."
                    } else {
                        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "android-unknown"
                        var lastLine = ""
                        for (daysAgo in 6 downTo 0) {
                            val (date, rows) = UsageReader.readForDay(this, daysAgo)
                            lastLine = SupabaseClient.upsertUsage(url, key, deviceId, date, rows)
                        }
                        "Uploaded last 7 days.\nToday: $lastLine"
                    }
                }
            } catch (e: Exception) {
                "ERROR: ${e.message}"
            }
            runOnUiThread { setStatus(msg) }
        }.start()
    }

    /** Schedule once-daily upload, first run ~23:55 local, then every 24h. Self-heals via yesterday+today upload. */
    private fun scheduleDaily() {
        val now = Calendar.getInstance()
        val next = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 23); set(Calendar.MINUTE, 55); set(Calendar.SECOND, 0)
            if (before(now)) add(Calendar.DAY_OF_MONTH, 1)
        }
        val delay = next.timeInMillis - now.timeInMillis

        val req = PeriodicWorkRequestBuilder<UsageUploadWorker>(1, TimeUnit.DAYS)
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .build()

        // KEEP: ensure exactly one stable daily job; don't disturb it on re-save.
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "daily-usage-upload", ExistingPeriodicWorkPolicy.KEEP, req
        )
    }

    private fun hasUsageAccess(): Boolean {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        // unsafeCheckOpNoThrow is API 29+; checkOpNoThrow on older (API 26-28) to avoid a launch crash.
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun setStatus(s: String) { status.text = "Status:\n$s" }
}
