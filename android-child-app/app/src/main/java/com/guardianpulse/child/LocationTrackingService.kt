package com.guardianpulse.child

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class LocationTrackingService : Service(), LocationListener {

    private lateinit var prefs: PrefsStore
    private lateinit var queue: OfflineQueueHelper
    private lateinit var locationManager: LocationManager
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private var flushTask: ScheduledFuture<*>? = null
    private var lastLocation: Location? = null

    override fun onCreate() {
        super.onCreate()
        prefs = PrefsStore(this)
        queue = OfflineQueueHelper(this)
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!prefs.isPaired || !prefs.trackingActive) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification(
            "Sharing live location with ${prefs.parentName.ifBlank { "Parent" }}"
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        startLocationUpdates()
        startPeriodicSync()
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            locationManager.removeUpdates(this)
        } catch (_: Exception) {
        }
        flushTask?.cancel(false)
        executor.shutdownNow()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onLocationChanged(location: Location) {
        lastLocation = location
        val point = buildPayload(location, source = "android-gps")
        prefs.lastSummary = String.format(
            Locale.US,
            "%.5f, %.5f (±%dm)",
            location.latitude,
            location.longitude,
            location.accuracy.toInt()
        )
        sendBroadcast(Intent(ACTION_TELEMETRY_UPDATED))

        executor.execute {
            queue.enqueue(point)
            flushQueueSync()
        }
    }

    @Deprecated("Required for older Android API compatibility")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    private fun startLocationUpdates() {
        val hasFine = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasFine && !hasCoarse) {
            stopSelf()
            return
        }

        try {
            locationManager.removeUpdates(this)
        } catch (_: Exception) {
        }

        if (hasFine && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                15_000L,
                10f,
                this
            )
        }
        if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            locationManager.requestLocationUpdates(
                LocationManager.NETWORK_PROVIDER,
                30_000L,
                25f,
                this
            )
        }

        // Send an immediate last-known fix if available
        val initial = if (hasFine) {
            locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        } else {
            locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        }
        if (initial != null) {
            onLocationChanged(initial)
        }
    }

    private fun startPeriodicSync() {
        flushTask?.cancel(false)
        flushTask = executor.scheduleWithFixedDelay(
            {
                // Heartbeat using latest fix if stationary so Parent sees child is still live
                lastLocation?.let { loc ->
                    if (System.currentTimeMillis() - loc.time > 60_000L) {
                        val heartbeat = Location(loc).apply { time = System.currentTimeMillis() }
                        queue.enqueue(buildPayload(heartbeat, source = "android-heartbeat"))
                    }
                }
                flushQueueSync()
            },
            20,
            45,
            TimeUnit.SECONDS
        )
    }

    private fun flushQueueSync() {
        val token = prefs.deviceToken
        val server = prefs.serverUrl
        if (token.isBlank() || server.isBlank()) return

        while (true) {
            val batch = queue.peekBatch(100)
            if (batch.isEmpty()) break
            try {
                val code = ApiClient.sendLocationBatch(server, token, batch.map { it.second })
                if (code in 200..299) {
                    queue.deleteIds(batch.map { it.first })
                    prefs.lastSyncedAt = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    sendBroadcast(Intent(ACTION_TELEMETRY_UPDATED))
                } else if (code == 401) {
                    prefs.clearPairing()
                    queue.clearAll()
                    sendBroadcast(Intent(ACTION_TELEMETRY_UPDATED))
                    stopSelf()
                    break
                } else {
                    break
                }
            } catch (_: Exception) {
                break
            }
        }
    }

    private fun buildPayload(location: Location, source: String): JSONObject {
        val (batteryLevel, isCharging) = readBattery()
        val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        return JSONObject().apply {
            put("lat", location.latitude)
            put("lng", location.longitude)
            put("accuracy", location.accuracy.toDouble())
            if (location.hasSpeed()) put("speed", location.speed.toDouble())
            if (location.hasBearing()) put("heading", location.bearing.toDouble())
            if (location.hasAltitude()) put("altitude", location.altitude)
            if (batteryLevel >= 0) put("batteryLevel", batteryLevel)
            put("isCharging", isCharging)
            put("source", source)
            put("recordedAt", isoFormat.format(Date(location.time)))
        }
    }

    private fun readBattery(): Pair<Int, Boolean> {
        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return pct to charging
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "24/7 Location Sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Persistent indicator while GuardianPulse location sharing is active."
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GuardianPulse Active")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "guardian_pulse_tracking"
        const val NOTIFICATION_ID = 1001
        const val ACTION_TELEMETRY_UPDATED = "com.guardianpulse.child.TELEMETRY_UPDATED"

        fun start(context: Context) {
            val intent = Intent(context, LocationTrackingService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationTrackingService::class.java))
        }
    }
}
