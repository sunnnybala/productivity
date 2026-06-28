package com.falconedge.activitypusher

import android.content.Context
import android.provider.Settings
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Daily background job (scheduled via WorkManager). Uploads the PREVIOUS complete
 * day plus today-so-far, each stamped with its own local date. Uploading the
 * previous day every run means a Doze-deferred or missed run still backfills it,
 * and the run time no longer determines which day gets recorded.
 *
 *   doWork() -> load prefs -> upload [yesterday, today] -> Result
 *     missing creds      -> success (no-op)
 *     4xx (permanent)    -> failure (no infinite retry)
 *     5xx / network      -> retry (backoff)
 */
class UsageUploadWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences(Prefs.NAME, Context.MODE_PRIVATE)
        val url = prefs.getString(Prefs.URL, null)
        val key = prefs.getString(Prefs.KEY, null)
        if (url.isNullOrBlank() || key.isNullOrBlank()) {
            return Result.success() // not configured yet; nothing to do
        }

        val deviceId = Settings.Secure.getString(
            applicationContext.contentResolver, Settings.Secure.ANDROID_ID
        ) ?: "android-unknown"

        return try {
            val results = StringBuilder()
            // Upload the last 7 days every run (UsageStats retains ~7d of daily data).
            // Idempotent upserts => any outage up to a week fully self-heals on the
            // next successful run — critical on aggressive OEMs (OnePlus/realme).
            for (daysAgo in 6 downTo 0) {
                val (date, rows) = UsageReader.readForDay(applicationContext, daysAgo)
                results.append(SupabaseClient.upsertUsage(url, key, deviceId, date, rows)).append("; ")
            }
            recordRun(prefs, "OK: $results")
            Result.success()
        } catch (e: HttpException) {
            recordRun(prefs, "HTTP ${e.code}: ${e.message}")
            // 4xx is a permanent client/config error — don't retry forever. 5xx is transient.
            if (e.code in 400..499 && e.code != 429) Result.failure() else Result.retry()
        } catch (e: Exception) {
            Log.w("ActivityPusher", "upload failed", e)
            recordRun(prefs, "ERROR: ${e.message}")
            Result.retry()
        }
    }

    private fun recordRun(prefs: android.content.SharedPreferences, status: String) {
        prefs.edit()
            .putLong(Prefs.LAST_RUN, System.currentTimeMillis())
            .putString(Prefs.LAST_STATUS, status)
            .apply()
    }
}

object Prefs {
    const val NAME = "activity_pusher"
    const val URL = "supabase_url"
    const val KEY = "supabase_key"
    const val LAST_RUN = "last_run_millis"
    const val LAST_STATUS = "last_status"
}
