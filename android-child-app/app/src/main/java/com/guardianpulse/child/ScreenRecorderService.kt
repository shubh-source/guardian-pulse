package com.guardianpulse.child

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class ScreenRecorderService : Service() {

    private lateinit var prefs: PrefsStore
    private lateinit var uploadStore: PendingScreenUploadStore
    private lateinit var projectionManager: MediaProjectionManager
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var powerManager: PowerManager

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadScheduledExecutor()
    private val recorderLock = Any()

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var mediaRecorder: MediaRecorder? = null
    private var currentFile: File? = null
    private var currentStartedAtMs: Long = 0L

    private var targetWidth: Int = 720
    private var targetHeight: Int = 1280
    private var screenDensityDpi: Int = DisplayMetrics.DENSITY_HIGH

    private var segmentRotationTask: ScheduledFuture<*>? = null
    private var retryUploadTask: ScheduledFuture<*>? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var screenStateReceiver: BroadcastReceiver? = null
    private var projectionCallback: MediaProjection.Callback? = null

    override fun onCreate() {
        super.onCreate()
        prefs = PrefsStore(this)
        uploadStore = PendingScreenUploadStore(this)
        projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager

        createNotificationChannel()
        computeTargetDimensions()
        registerScreenStateReceiver()
        registerNetworkCallback()
        startRetryLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!prefs.isPaired || !prefs.trackingActive) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification(
            "Screen protection active · Sending clips to ${prefs.parentName.ifBlank { "Parent" }}"
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        val resultData: Intent? = if (intent == null) {
            null
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_RESULT_DATA)
        }

        if (mediaProjection == null) {
            if (resultCode != Activity.RESULT_OK || resultData == null) {
                prefs.screenRecordingEnabled = false
                prefs.lastScreenSummary = "Screen capture permission required"
                sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                stopSelf()
                return START_NOT_STICKY
            }

            try {
                val projection = projectionManager.getMediaProjection(resultCode, resultData)
                if (projection == null) {
                    prefs.screenRecordingEnabled = false
                    sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                    stopSelf()
                    return START_NOT_STICKY
                }
                val cb = object : MediaProjection.Callback() {
                    override fun onStop() {
                        mainHandler.post {
                            handleProjectionRevoked()
                        }
                    }
                }
                projection.registerCallback(cb, mainHandler)
                projectionCallback = cb
                mediaProjection = projection
                isRunning = true
                prefs.screenRecordingEnabled = true
                prefs.lastScreenSummary = "Recording display (${targetWidth}x${targetHeight} @ ${VIDEO_FPS}fps)"
                sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))

                if (powerManager.isInteractive) {
                    startNextSegment()
                } else {
                    prefs.lastScreenSummary = "Paused while phone screen is off"
                    sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                }
            } catch (e: Exception) {
                prefs.screenRecordingEnabled = false
                prefs.lastScreenSummary = "Screen capture failed: ${e.message ?: "error"}"
                sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                stopSelf()
                return START_NOT_STICKY
            }
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        segmentRotationTask?.cancel(false)
        retryUploadTask?.cancel(false)
        unregisterScreenStateReceiver()
        unregisterNetworkCallback()

        synchronized(recorderLock) {
            stopCurrentSegmentLocked(enqueueForUpload = true)
            releaseProjectionLocked()
        }
        ioExecutor.execute { flushUploadsSync() }
        ioExecutor.shutdown()
        sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun handleProjectionRevoked() {
        synchronized(recorderLock) {
            stopCurrentSegmentLocked(enqueueForUpload = true)
            releaseProjectionLocked()
        }
        isRunning = false
        prefs.screenRecordingEnabled = false
        prefs.lastScreenSummary = "Screen recording stopped"
        sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
        stopSelf()
    }

    private fun startNextSegment() {
        synchronized(recorderLock) {
            if (mediaProjection == null || !prefs.isPaired || !prefs.trackingActive) return
            if (!powerManager.isInteractive) return

            stopCurrentSegmentLocked(enqueueForUpload = true)

            val dir = File(cacheDir, "screen_clips").apply { mkdirs() }
            val outFile = File(dir, "screen_${System.currentTimeMillis()}.mp4")

            try {
                val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaRecorder(this)
                } else {
                    @Suppress("DEPRECATION")
                    MediaRecorder()
                }

                recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                recorder.setVideoEncodingBitRate(VIDEO_BITRATE)
                recorder.setVideoFrameRate(VIDEO_FPS)
                recorder.setVideoSize(targetWidth, targetHeight)
                recorder.setOutputFile(outFile.absolutePath)
                recorder.prepare()

                val surface = recorder.surface
                if (virtualDisplay == null) {
                    virtualDisplay = mediaProjection?.createVirtualDisplay(
                        "GuardianPulseDisplay",
                        targetWidth,
                        targetHeight,
                        screenDensityDpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        surface,
                        null,
                        mainHandler
                    )
                } else {
                    virtualDisplay?.surface = surface
                }

                recorder.start()
                mediaRecorder = recorder
                currentFile = outFile
                currentStartedAtMs = System.currentTimeMillis()
                updateNotification("Recording display (${targetWidth}x${targetHeight}) · ${prefs.parentName.ifBlank { "Parent" }}")

                scheduleSegmentRotation()
            } catch (e: Exception) {
                try {
                    outFile.delete()
                } catch (_: Exception) {
                }
                mediaRecorder = null
                currentFile = null
                prefs.lastScreenSummary = "Screen segment error: ${e.message ?: "unknown"}"
                sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
            }
        }
    }

    private fun stopCurrentSegmentLocked(enqueueForUpload: Boolean) {
        segmentRotationTask?.cancel(false)
        segmentRotationTask = null

        val recorder = mediaRecorder
        val file = currentFile
        val startMs = currentStartedAtMs
        mediaRecorder = null
        currentFile = null
        currentStartedAtMs = 0L

        if (recorder != null) {
            try {
                virtualDisplay?.surface = null
            } catch (_: Exception) {
            }
            try {
                recorder.stop()
            } catch (_: Exception) {
                try {
                    file?.delete()
                } catch (_: Exception) {
                }
            }
            try {
                recorder.reset()
                recorder.release()
            } catch (_: Exception) {
            }
        }

        if (enqueueForUpload && file != null && file.exists() && file.length() > 1024L && startMs > 0L) {
            val endMs = System.currentTimeMillis()
            val durationSec = ((endMs - startMs) / 1000L).toInt().coerceAtLeast(1)
            val startedIso = formatIsoUtc(startMs)
            val endedIso = formatIsoUtc(endMs)
            val width = targetWidth
            val height = targetHeight

            prefs.lastScreenSummary = "${width}x${height} clip (${durationSec}s)"
            sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))

            ioExecutor.execute {
                uploadStore.enqueue(
                    filePath = file.absolutePath,
                    startedAt = startedIso,
                    endedAt = endedIso,
                    durationSec = durationSec,
                    width = width,
                    height = height,
                    fps = VIDEO_FPS,
                    mimeType = "video/mp4"
                )
                sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                flushUploadsSync()
            }
        } else if (file != null && file.exists()) {
            try {
                file.delete()
            } catch (_: Exception) {
            }
        }
    }

    private fun releaseProjectionLocked() {
        try {
            virtualDisplay?.release()
        } catch (_: Exception) {
        }
        virtualDisplay = null

        val projection = mediaProjection
        mediaProjection = null
        val cb = projectionCallback
        projectionCallback = null
        if (projection != null) {
            try {
                if (cb != null) projection.unregisterCallback(cb)
            } catch (_: Exception) {
            }
            try {
                projection.stop()
            } catch (_: Exception) {
            }
        }
    }

    private fun scheduleSegmentRotation() {
        segmentRotationTask?.cancel(false)
        segmentRotationTask = ioExecutor.schedule(
            {
                mainHandler.post {
                    if (isRunning && powerManager.isInteractive) {
                        startNextSegment()
                    }
                }
            },
            SEGMENT_DURATION_SEC.toLong(),
            TimeUnit.SECONDS
        )
    }

    private fun computeTargetDimensions() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val rawW: Int
        val rawH: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.maximumWindowMetrics.bounds
            rawW = bounds.width()
            rawH = bounds.height()
            screenDensityDpi = resources.configuration.densityDpi
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            rawW = metrics.widthPixels
            rawH = metrics.heightPixels
            screenDensityDpi = metrics.densityDpi
        }

        val shortSide = max(1, min(rawW, rawH))
        val scale = if (shortSide > MAX_SHORT_SIDE_PX) {
            MAX_SHORT_SIDE_PX.toFloat() / shortSide.toFloat()
        } else {
            1f
        }

        // H.264 encoders require even dimensions
        targetWidth = ((rawW * scale).roundToInt() and 1.inv()).coerceAtLeast(240)
        targetHeight = ((rawH * scale).roundToInt() and 1.inv()).coerceAtLeast(240)
    }

    private fun flushUploadsSync() {
        val token = prefs.deviceToken
        val server = prefs.serverUrl
        if (token.isBlank() || server.isBlank()) return

        while (true) {
            val batch = uploadStore.peekBatch(5)
            if (batch.isEmpty()) break

            var shouldStopLoop = false
            for (item in batch) {
                try {
                    val code = ApiClient.uploadScreenRecording(server, token, item)
                    when {
                        code in 200..299 || code == 410 -> {
                            uploadStore.deleteAndCleanup(item)
                            if (code in 200..299) {
                                prefs.lastScreenUploadedAt =
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
        retryUploadTask?.cancel(false)
        retryUploadTask = ioExecutor.scheduleWithFixedDelay(
            { flushUploadsSync() },
            15,
            60,
            TimeUnit.SECONDS
        )
    }

    private fun registerScreenStateReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_OFF -> {
                        synchronized(recorderLock) {
                            stopCurrentSegmentLocked(enqueueForUpload = true)
                        }
                        prefs.lastScreenSummary = "Paused while phone screen is off"
                        updateNotification("Screen off · Waiting for display to wake")
                        sendBroadcast(Intent(LocationTrackingService.ACTION_TELEMETRY_UPDATED))
                    }
                    Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> {
                        if (isRunning && mediaProjection != null && mediaRecorder == null && powerManager.isInteractive) {
                            startNextSegment()
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        screenStateReceiver = receiver
    }

    private fun unregisterScreenStateReceiver() {
        screenStateReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (_: Exception) {
            }
        }
        screenStateReceiver = null
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
        networkCallback = null
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
                "Auto Screen Recording",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active indicator while GuardianPulse records and uploads screen clips."
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
            .setContentTitle("GuardianPulse Screen Recorder")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "guardian_pulse_screen_recorder"
        const val NOTIFICATION_ID = 1004
        private const val EXTRA_RESULT_CODE = "extra_result_code"
        private const val EXTRA_RESULT_DATA = "extra_result_data"
        private const val MAX_SHORT_SIDE_PX = 720
        private const val VIDEO_FPS = 10
        private const val VIDEO_BITRATE = 1_200_000
        private const val SEGMENT_DURATION_SEC = 60

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, ScreenRecorderService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ScreenRecorderService::class.java))
        }
    }
}
