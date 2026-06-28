package com.falconedge.activitypusher

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import java.util.Calendar
import java.util.TimeZone

/**
 * Reads per-app foreground time for a specific LOCAL day by summing actual
 * foreground/background EVENTS (queryEvents), not the aggregate-summary API.
 *
 * Why events, not queryAndAggregateUsageStats: the aggregate API falls back to a
 * coarser (weekly) bucket near the ~7-day retention edge and over-counts the oldest
 * day (we saw Jun 22 report 62 hours). Summing resume->pause intervals inside the
 * exact [dayStart, dayEnd) window is accurate regardless of how far back we read.
 *
 * Day boundaries use a FIXED zone (Asia/Kolkata) so phone days match the laptop view.
 */
object UsageReader {

    private val TZ: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")

    data class AppUsage(val pkg: String, val label: String?, val minutes: Double)

    fun readForDay(context: Context, daysAgo: Int): Pair<String, List<AppUsage>> {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val pm = context.packageManager

        val cal = Calendar.getInstance(TZ)
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        cal.add(Calendar.DAY_OF_MONTH, -daysAgo)
        val start = cal.timeInMillis
        val end = minOf(start + 24L * 60 * 60 * 1000, System.currentTimeMillis())
        val date = dateString(start)
        if (end <= start) return date to emptyList()

        // Sum foreground intervals per package from the raw event stream.
        val totalsMs = HashMap<String, Long>()
        val fgStart = HashMap<String, Long>()   // package -> timestamp it last went foreground
        val events = usm.queryEvents(start, end)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            val pkg = e.packageName ?: continue
            when (e.eventType) {
                @Suppress("DEPRECATION")
                UsageEvents.Event.MOVE_TO_FOREGROUND -> fgStart[pkg] = e.timeStamp   // == ACTIVITY_RESUMED (1)
                @Suppress("DEPRECATION")
                UsageEvents.Event.MOVE_TO_BACKGROUND -> {                            // == ACTIVITY_PAUSED (2)
                    val s = fgStart.remove(pkg)
                    if (s != null && e.timeStamp > s) totalsMs[pkg] = (totalsMs[pkg] ?: 0) + (e.timeStamp - s)
                }
            }
        }
        // Apps still foreground at window end (e.g. spilled across midnight): close at end.
        for ((pkg, s) in fgStart) if (end > s) totalsMs[pkg] = (totalsMs[pkg] ?: 0) + (end - s)

        val rows = totalsMs.entries
            .filter { it.value > 0 }
            .map { AppUsage(it.key, labelFor(pm, it.key), it.value / 60000.0) }
            .sortedByDescending { it.minutes }
        return date to rows
    }

    private fun labelFor(pm: PackageManager, pkg: String): String? = try {
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (ex: PackageManager.NameNotFoundException) {
        null
    }

    private fun dateString(epochMillis: Long): String {
        val c = Calendar.getInstance(TZ); c.timeInMillis = epochMillis
        return String.format("%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }
}
