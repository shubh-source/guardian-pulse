package com.guardianpulse.child

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

data class PairResult(
    val deviceToken: String,
    val childName: String,
    val parentName: String,
    val deviceName: String
)

object ApiClient {

    fun pair(serverUrl: String, pairingCode: String, deviceName: String): PairResult {
        val body = JSONObject().apply {
            put("pairingCode", pairingCode.trim().uppercase())
            put("deviceName", deviceName.trim())
        }
        val response = postJson("$serverUrl/api/pair", body, deviceToken = null)
        val child = response.getJSONObject("child")
        return PairResult(
            deviceToken = response.getString("deviceToken"),
            childName = child.getString("name"),
            parentName = child.optString("parentName", "Parent"),
            deviceName = child.optString("deviceName", deviceName)
        )
    }

    fun sendTrackingState(serverUrl: String, deviceToken: String, active: Boolean) {
        val body = JSONObject().put("active", active)
        postJson("$serverUrl/api/device/tracking-state", body, deviceToken)
    }

    /**
     * Returns HTTP status code (201 on success, 401 if token revoked).
     */
    fun sendLocationBatch(serverUrl: String, deviceToken: String, points: List<JSONObject>): Int {
        val arr = JSONArray()
        for (p in points) arr.put(p)
        val body = JSONObject().put("points", arr)
        return postRaw("$serverUrl/api/locations", body, deviceToken).first
    }

    private fun postJson(urlStr: String, body: JSONObject, deviceToken: String?): JSONObject {
        val (code, text) = postRaw(urlStr, body, deviceToken)
        val json = if (text.isNotBlank()) JSONObject(text) else JSONObject()
        if (code !in 200..299) {
            throw IllegalStateException(json.optString("error", "Server error ($code)"))
        }
        return json
    }

    private fun postRaw(urlStr: String, body: JSONObject, deviceToken: String?): Pair<Int, String> {
        val url = URL(urlStr)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 12000
            readTimeout = 15000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            if (!deviceToken.isNullOrBlank()) {
                setRequestProperty("X-Device-Token", deviceToken)
            }
        }
        try {
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                writer.write(body.toString())
                writer.flush()
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val responseText = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { r -> r.readText() }
            } ?: ""
            return code to responseText
        } finally {
            conn.disconnect()
        }
    }
}
