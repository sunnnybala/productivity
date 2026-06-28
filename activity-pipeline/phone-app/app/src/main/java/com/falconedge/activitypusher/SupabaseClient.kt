package com.falconedge.activitypusher

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Thrown on a non-2xx HTTP response so callers can distinguish 4xx (permanent) from 5xx (retry). */
class HttpException(val code: Int, message: String) : RuntimeException(message)

/**
 * Minimal Supabase PostgREST client (no external HTTP library).
 *
 * Upserts rows into phone_app_usage with an idempotent merge:
 *   POST /rest/v1/phone_app_usage
 *   Prefer: return=minimal,resolution=merge-duplicates
 * Deterministic id (device|date|package) => re-running the same day refreshes
 * that day's totals instead of duplicating.
 */
object SupabaseClient {

    /** Upserts the rows for one local day. Returns a short status string. Throws HttpException / IOException on failure. */
    fun upsertUsage(
        baseUrl: String,
        anonKey: String,
        deviceId: String,
        date: String,
        rows: List<UsageReader.AppUsage>
    ): String {
        if (rows.isEmpty()) return "0 apps for $date (nothing to upload)"

        val arr = JSONArray()
        for (r in rows) {
            val o = JSONObject()
            o.put("id", "$deviceId|$date|${r.pkg}")
            o.put("device_id", deviceId)
            o.put("usage_date", date)
            o.put("package", r.pkg)
            // Keep keys uniform across all rows (PostgREST rejects mixed-key arrays).
            o.put("app_label", r.label ?: JSONObject.NULL)
            o.put("minutes", Math.round(r.minutes * 10.0) / 10.0)
            arr.put(o)
        }

        val url = URL(baseUrl.trimEnd('/') + "/rest/v1/phone_app_usage")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 20000
            conn.readTimeout = 30000
            conn.setRequestProperty("apikey", anonKey)
            conn.setRequestProperty("Authorization", "Bearer $anonKey")
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Prefer", "return=minimal,resolution=merge-duplicates")

            conn.outputStream.use { it.write(arr.toString().toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            if (code in 200..299) return "OK ($code): ${rows.size} apps for $date"
            val err = conn.errorStream?.bufferedReader()?.readText() ?: ""
            throw HttpException(code, "Supabase HTTP $code: $err")
        } finally {
            conn.disconnect()
        }
    }
}
