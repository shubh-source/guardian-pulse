package com.guardianpulse.child

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.provider.CallLog
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.abs

class CallRecorderService : Service() {

    private lateinit var prefs: PrefsStore
    private lateinit var uploadStore: PendingUploadStore
    private lateinit var audioRecorder: CallAudioRecorder
    private lateinit var telephonyManager: TelephonyManager
    private lateinit var connectivityManager: ConnectivityManager

    private val ioExecutor = Executors.newSingleThreadScheduledExecutor()
    private var retryTask: ScheduledFuture<*>? = null
    private var telephonyCallback: Any? = null
    @Suppress("DEPRECATION")
    private var legacyPhoneListener: PhoneStateListener? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val stateLock = Any()
    private var pendingDirection: String? = null
    private var pendingNumber: String? = null
    private var activeDirection: String = "outgoing"
    private var activeNumber: String = "Unknown"
    private var activeStartedAtMs: Long = 0L

    override fun onCreate() {
        super.onCreate()
        prefs = PrefsStore(this)
        uploadStore = PendingUploadStore(this)
        audioRecorder = CallAudioRecorder(this)
        telephonyManager = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

        createNotificationChannel()
        registerCallStateListener()
        registerNetworkCallback()
        startRetryLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!prefs.isPaired || !prefs.trackingActive || !prefs.callRecordingEnabled) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification(
            "Auto call recording active · Sending to ${prefs.parentName.ifBlank { "Parent" }}"
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        when (intent?.action) {
            ACTION_OUTGOING_NUMBER -> {
                val number = intent.getStringExtra(EXTRA_PHONE_NUMBER)
                synchronized(stateLock) {
                    pendingDirection = "outgoing"
                    if (!number.isNullOrBlank()) {
                        pendingNumber = number.trim()
                        if (audioRecorder.isRecording && activeNumber == "Unknown") {
                            activeNumber = number.trim()
                        }
                    }
                }
            }
            ACTION_PHONE_STATE_UPDATE -> {
                val stateInt = intent.getIntExtra(EXTRA_CALL_STATE, TelephonyManager.CALL_STATE_IDLE)
                val number = intent.getStringExtra(EXTRA_PHONE_NUMBER)
                handleCallStateTransition(stateInt, number)
            }
            ACTION_FLUSH_UPLOADS -> {
                ioExecutor.execute { flushUploadsSync() }
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterCallStateListener()
        unregisterNetworkCallback()
        retryTask?.cancel(false)
        if (audioRecorder.isRecording) {
            audioRecorder.stop()?.file?.delete()
        }
        ioExecutor.shutdownNow()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun handleCallStateTransition(newState: Int, numberHint: String?) {
        synchronized(stateLock) {
            if (!numberHint.isNullOrBlank()) {
                pendingNumber = numberHint.trim()
                if (audioRecorder.isRecording && activeNumber == "Unknown") {
                    activeNumber = numberHint.trim()
                }
            }

            when (newState) {
                TelephonyManager.CALL_STATE_RINGING -> {
                    if (!audioRecorder.isRecording) {
                        pendingDirection = "incoming"
                    }
                }
                TelephonyManager.CALL_STATE_OFFHOOK -> {
                    if (!audioRecorder.isRecording) {
                        val direction = if (pendingDirection == "incoming") "incoming" else "outgoing"
                        val number = pendingNumber?.takeIf { it.isNotBlank() } ?: "Unknown"
                        if (hasRecordPermission() && audioRecorder.start(prefs.speakerBoostEnabled)) {
                            activeDirection = direction
                            activeNumber = number
                            activeStartedAtMs = System.currentTimeMillis()
                            updateNotification("Recording $direction call ($number)")
                        }
                    }
                }
                TelephonyManager.CALL_STATE_IDLE -> {
                    if (audioRecorder.isRecording) {
                        val result = audioRecorder.stop()
                        val dir = activeDirection
                        val num = activeNumber
                        val startMs = activeStartedAtMs
                        val endMs = System.currentTimeMillis()

                        pendingDirection = null
                        pendingNumber = null
                        activeNumber = "Unknown"
                        updateNotification(
                            "Auto call recording active · Sending to ${prefs.parentName.ifBlank { "Parent" }}"
                        )

                        if (result != null) {
                            ioExecutor.schedule(
                                { finalizeAndUploadCall(result, dir, num, startMs, endMs) },
                                900L,
                                TimeUnit.MILLISECONDS
                            )
                        }
                    } else {
                        pendingDirection = null
                        pendingNumber = null
                    }
                }
            }
        }
    }

    private fun finalizeAndUploadCall(
        result: RecordedAudioResult,
        direction: String,
        initialNumber: String,
        startMs: Long,
        endMs: Long
    ) {
        val resolved = resolveCallLogDetails(initialNumber, direction, startMs, endMs)
        val finalNumber = resolved.first
        val finalDirection = resolved.second

        val startedIso = formatIsoUtc(startMs)
        val endedIso = formatIsoUtc(endMs)
        val durationSec = result.durationSec.coerceAtLeast(
            ((endMs - startMs) / 1000L).toInt().coerceAtLeast(0)
        )

        prefs.lastCallSummary =
            "${finalDirection.uppercase(Locale.US)} · $finalNumber (${durationSec}s)"
        sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))

        uploadStore.enqueue(
            filePath = result.file.absolutePath,
            direction = finalDirection,
            phoneNumber = finalNumber,
            startedAt = startedIso,
            endedAt = endedIso,
            durationSec = durationSec,
            mimeType = result.mimeType,
            audioSource = result.audioSource
        )
        sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
        flushUploadsSync()
    }

    private fun resolveCallLogDetails(
        fallbackNumber: String,
        fallbackDirection: String,
        startMs: Long,
        endMs: Long
    ): Pair<String, String> {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return fallbackNumber to fallbackDirection
        }

        try {
            val projection = arrayOf(
                CallLog.Calls.NUMBER,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE
            )
            contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                null,
                null,
                "${CallLog.Calls.DATE} DESC LIMIT 3"
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    val number = cursor.getString(0)?.trim()
                    val type = cursor.getInt(1)
                    val callDate = cursor.getLong(2)
                    val withinWindow =
                        abs(callDate - startMs) <= 20_000L || abs(callDate - endMs) <= 20_000L
                    if (!withinWindow) continue

                    val dir = when (type) {
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        else -> fallbackDirection
                    }
                    val chosenNumber = if (!number.isNullOrBlank()) number else fallbackNumber
                    return chosenNumber to dir
                }
            }
        } catch (_: Exception) {
        }
        return fallbackNumber to fallbackDirection
    }

    private fun flushUploadsSync() {
        val token = prefs.deviceToken
        val server = prefs.serverUrl
        if (token.isBlank() || server.isBlank()) return

        while (true) {
            val batch = uploadStore.peekBatch(10)
            if (batch.isEmpty()) break

            var shouldStopLoop = false
            for (item in batch) {
                try {
                    val code = ApiClient.uploadCallRecording(server, token, item)
                    when {
                        code in 200..299 || code == 410 -> {
                            uploadStore.deleteAndCleanup(item)
                            if (code in 200..299) {
                                prefs.lastCallUploadedAt =
                                    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                            }
                            sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                        }
                        code == 401 -> {
                            prefs.clearPairing()
                            uploadStore.clearAll()
                            sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                            stopSelf()
                            shouldStopLoop = true
                            break
                        }
                        else -> {
                            shouldStopLoop = true
                            break
                        }
                    }
                } catch (_: Exception) {
                    shouldStopLoop = true
                    break
                }
            }
            if (shouldStopLoop) break
        }
    }

    private fun startRetryLoop() {
        retryTask?.cancel(false)
        retryTask = ioExecutor.scheduleWithFixedDelay(
            { flushUploadsSync() },
            10,
            60,
            TimeUnit.SECONDS
        )
    }

    private fun registerCallStateListener() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val cb = Api31CallStateCallback { state ->
                    handleCallStateTransition(state, null)
                }
                telephonyManager.registerTelephonyCallback(mainExecutor, cb)
                telephonyCallback = cb
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        handleCallStateTransition(state, phoneNumber)
                    }
                }
                @Suppress("DEPRECATION")
                telephonyManager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
                legacyPhoneListener = listener
            }
        } catch (_: Exception) {
        }
    }

    private fun unregisterCallStateListener() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (telephonyCallback as? TelephonyCallback)?.let {
                    telephonyManager.unregisterTelephonyCallback(it)
                }
            } else {
                @Suppress("DEPRECATION")
                legacyPhoneListener?.let {
                    telephonyManager.listen(it, PhoneStateListener.LISTEN_NONE)
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun registerNetworkCallback() {
        try {
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    ioExecutor.execute { flushUploadsSync() }
                }
            }
            connectivityManager.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (_: Exception) {
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let { connectivityManager.unregisterNetworkCallback(it) }
        } catch (_: Exception) {
        }
    }

    private fun hasRecordPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun formatIsoUtc(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        return fmt.format(Date(ms))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Auto Call Recording",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active indicator while GuardianPulse automatically records and uploads calls."
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GuardianPulse Call Recorder")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private class Api31CallStateCallback(
        private val onChange: (Int) -> Unit
    ) : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) {
            onChange(state)
        }
    }

    companion object {
        const val CHANNEL_ID = "guardian_pulse_call_recorder"
        const val NOTIFICATION_ID = 1002
        const val ACTION_PHONE_STATE_UPDATE = "com.guardianpulse.child.PHONE_STATE_UPDATE"
        const val ACTION_OUTGOING_NUMBER = "com.guardianpulse.child.OUTGOING_NUMBER"
        const val ACTION_FLUSH_UPLOADS = "com.guardianpulse.child.FLUSH_CALL_UPLOADS"
        const val EXTRA_CALL_STATE = "extra_call_state"
        const val EXTRA_PHONE_NUMBER = "extra_phone_number"

        fun start(context: Context) {
            val intent = Intent(context, CallRecorderService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallRecorderService::class.java))
        }
    }
}
