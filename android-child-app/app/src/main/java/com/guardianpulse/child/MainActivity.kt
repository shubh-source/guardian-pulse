package com.guardianpulse.child

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: PrefsStore
    private lateinit var queue: OfflineQueueHelper
    private lateinit var callUploadStore: PendingUploadStore
    private lateinit var screenUploadStore: PendingScreenUploadStore
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private lateinit var pairCard: LinearLayout
    private lateinit var trackerCard: LinearLayout
    private lateinit var serverUrlInput: EditText
    private lateinit var pairingCodeInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var pairErrorText: TextView
    private lateinit var pairButton: Button

    private lateinit var statusTitle: TextView
    private lateinit var sharedWithLabel: TextView
    private lateinit var telemetryCoords: TextView
    private lateinit var telemetrySync: TextView
    private lateinit var lastCallText: TextView
    private lateinit var callUploadStatusText: TextView
    private lateinit var lastScreenText: TextView
    private lateinit var screenUploadStatusText: TextView
    private lateinit var callRecordingSwitch: SwitchCompat
    private lateinit var speakerBoostSwitch: SwitchCompat
    private lateinit var screenRecordingSwitch: SwitchCompat
    private lateinit var toggleButton: Button
    private lateinit var permissionsButton: Button
    private lateinit var unpairButton: Button
    private var suppressScreenSwitchListener = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        requestBackgroundLocationIfNeeded()
        startActiveServicesIfPermitted()
        renderUi()
    }

    private val backgroundPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        startActiveServicesIfPermitted()
    }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            prefs.screenRecordingEnabled = true
            ScreenRecorderService.start(this, result.resultCode, data)
        } else {
            prefs.screenRecordingEnabled = false
            prefs.lastScreenSummary = "Screen capture permission declined"
        }
        renderUi()
    }

    private val telemetryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            renderUi()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = PrefsStore(this)
        queue = OfflineQueueHelper(this)
        callUploadStore = PendingUploadStore(this)
        screenUploadStore = PendingScreenUploadStore(this)

        pairCard = findViewById(R.id.pairCard)
        trackerCard = findViewById(R.id.trackerCard)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        pairingCodeInput = findViewById(R.id.pairingCodeInput)
        deviceNameInput = findViewById(R.id.deviceNameInput)
        pairErrorText = findViewById(R.id.pairErrorText)
        pairButton = findViewById(R.id.pairButton)

        statusTitle = findViewById(R.id.statusTitle)
        sharedWithLabel = findViewById(R.id.sharedWithLabel)
        telemetryCoords = findViewById(R.id.telemetryCoords)
        telemetrySync = findViewById(R.id.telemetrySync)
        lastCallText = findViewById(R.id.lastCallText)
        callUploadStatusText = findViewById(R.id.callUploadStatusText)
        lastScreenText = findViewById(R.id.lastScreenText)
        screenUploadStatusText = findViewById(R.id.screenUploadStatusText)
        callRecordingSwitch = findViewById(R.id.callRecordingSwitch)
        speakerBoostSwitch = findViewById(R.id.speakerBoostSwitch)
        screenRecordingSwitch = findViewById(R.id.screenRecordingSwitch)
        toggleButton = findViewById(R.id.toggleButton)
        permissionsButton = findViewById(R.id.permissionsButton)
        unpairButton = findViewById(R.id.unpairButton)

        serverUrlInput.setText(prefs.serverUrl)
        deviceNameInput.setText(Build.MODEL ?: "Android Phone")
        callRecordingSwitch.isChecked = prefs.callRecordingEnabled
        speakerBoostSwitch.isChecked = prefs.speakerBoostEnabled
        syncScreenSwitchChecked(ScreenRecorderService.isRunning)

        callRecordingSwitch.setOnCheckedChangeListener { _, isChecked ->
            prefs.callRecordingEnabled = isChecked
            if (prefs.isPaired && prefs.trackingActive && isChecked) {
                if (hasCallMicPermissions()) {
                    CallRecorderService.start(this)
                } else {
                    requestRequiredPermissions()
                }
            } else {
                CallRecorderService.stop(this)
            }
            renderUi()
        }

        speakerBoostSwitch.setOnCheckedChangeListener { _, isChecked ->
            prefs.speakerBoostEnabled = isChecked
        }

        screenRecordingSwitch.setOnCheckedChangeListener { _, isChecked ->
            if (suppressScreenSwitchListener) return@setOnCheckedChangeListener
            if (isChecked) {
                if (!prefs.isPaired || !prefs.trackingActive) {
                    syncScreenSwitchChecked(false)
                    return@setOnCheckedChangeListener
                }
                requestScreenCaptureConsent()
            } else {
                prefs.screenRecordingEnabled = false
                ScreenRecorderService.stop(this)
                renderUi()
            }
        }

        pairButton.setOnClickListener { handlePair() }
        toggleButton.setOnClickListener { toggleTracking() }
        permissionsButton.setOnClickListener {
            requestRequiredPermissions()
            promptIgnoreBatteryOptimizations()
        }
        unpairButton.setOnClickListener { handleUnpair() }

        renderUi()
        if (prefs.isPaired && prefs.trackingActive) {
            requestRequiredPermissions()
            startActiveServicesIfPermitted()
            if (prefs.screenRecordingEnabled && !ScreenRecorderService.isRunning) {
                requestScreenCaptureConsent()
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(LocationTrackingService.ACTION_TELEMETRY_UPDATED)
        ContextCompat.registerReceiver(
            this,
            telemetryReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        renderUi()
    }

    override fun onStop() {
        super.onStop()
        try {
            unregisterReceiver(telemetryReceiver)
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        ioExecutor.shutdownNow()
    }

    private fun handlePair() {
        val serverUrl = serverUrlInput.text.toString().trim().trimEnd('/')
        val code = pairingCodeInput.text.toString().trim().uppercase()
        val devName = deviceNameInput.text.toString().trim().ifBlank { Build.MODEL ?: "Android" }

        if (serverUrl.isBlank() || (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://"))) {
            showPairError("Enter a valid Server URL (e.g. http://192.168.1.10:3001)")
            return
        }
        if (code.length < 4) {
            showPairError("Enter the 6-character pairing code from the Parent App")
            return
        }

        pairErrorText.visibility = View.GONE
        pairButton.isEnabled = false

        ioExecutor.execute {
            try {
                val result = ApiClient.pair(serverUrl, code, devName)
                prefs.serverUrl = serverUrl
                prefs.deviceToken = result.deviceToken
                prefs.childName = result.childName
                prefs.parentName = result.parentName
                prefs.deviceName = result.deviceName
                prefs.trackingActive = true

                runOnUiThread {
                    pairButton.isEnabled = true
                    renderUi()
                    requestRequiredPermissions()
                    startActiveServicesIfPermitted()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    pairButton.isEnabled = true
                    showPairError(e.message ?: "Pairing failed")
                }
            }
        }
    }

    private fun toggleTracking() {
        val next = !prefs.trackingActive
        prefs.trackingActive = next
        if (next) {
            requestRequiredPermissions()
            startActiveServicesIfPermitted()
        } else {
            LocationTrackingService.stop(this)
            CallRecorderService.stop(this)
            ScreenRecorderService.stop(this)
        }
        ioExecutor.execute {
            try {
                ApiClient.sendTrackingState(prefs.serverUrl, prefs.deviceToken, next)
            } catch (_: Exception) {
            }
        }
        renderUi()
    }

    private fun handleUnpair() {
        val token = prefs.deviceToken
        val url = prefs.serverUrl
        LocationTrackingService.stop(this)
        CallRecorderService.stop(this)
        ScreenRecorderService.stop(this)
        prefs.clearPairing()
        queue.clearAll()
        callUploadStore.clearAll()
        screenUploadStore.clearAll()
        ioExecutor.execute {
            try {
                if (token.isNotBlank()) {
                    ApiClient.sendTrackingState(url, token, false)
                }
            } catch (_: Exception) {
            }
        }
        renderUi()
    }

    private fun startActiveServicesIfPermitted() {
        if (!prefs.isPaired || !prefs.trackingActive) return
        if (hasForegroundLocation()) {
            LocationTrackingService.start(this)
        }
        if (prefs.callRecordingEnabled && hasCallMicPermissions()) {
            CallRecorderService.start(this)
        }
    }

    private fun showPairError(msg: String) {
        pairErrorText.text = msg
        pairErrorText.visibility = View.VISIBLE
    }

    private fun renderUi() {
        if (!prefs.isPaired) {
            pairCard.visibility = View.VISIBLE
            trackerCard.visibility = View.GONE
            return
        }

        pairCard.visibility = View.GONE
        trackerCard.visibility = View.VISIBLE

        if (prefs.trackingActive) {
            val activeModules = mutableListOf("Location")
            if (prefs.callRecordingEnabled) activeModules.add("Calls")
            if (ScreenRecorderService.isRunning) activeModules.add("Screen")
            statusTitle.text = "24/7 Protection Active (${activeModules.joinToString(" + ")})"
            statusTitle.setTextColor(0xFF10B981.toInt())
            toggleButton.text = "Pause Protection"
        } else {
            statusTitle.text = "Protection Paused"
            statusTitle.setTextColor(0xFFF59E0B.toInt())
            toggleButton.text = "Resume Protection"
        }

        sharedWithLabel.text =
            "Child: ${prefs.childName} · Parent: ${prefs.parentName} (${prefs.deviceName})"
        telemetryCoords.text = "Last fix: ${prefs.lastSummary}"
        telemetrySync.text = "Last GPS sync: ${prefs.lastSyncedAt} · GPS queue: ${queue.count()}"
        lastCallText.text = "Last call: ${prefs.lastCallSummary}"
        callUploadStatusText.text =
            "Last call sent: ${prefs.lastCallUploadedAt} · Call upload queue: ${callUploadStore.count()}"
        lastScreenText.text = "Last screen clip: ${prefs.lastScreenSummary}"
        screenUploadStatusText.text =
            "Last screen sent: ${prefs.lastScreenUploadedAt} · Screen upload queue: ${screenUploadStore.count()}"
        syncScreenSwitchChecked(ScreenRecorderService.isRunning)
    }

    private fun syncScreenSwitchChecked(checked: Boolean) {
        suppressScreenSwitchListener = true
        screenRecordingSwitch.isChecked = checked
        suppressScreenSwitchListener = false
    }

    private fun requestScreenCaptureConsent() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun hasForegroundLocation(): Boolean {
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasCallMicPermissions(): Boolean {
        val mic = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        val phone = ContextCompat.checkSelfPermission(
            this, Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED
        return mic && phone
    }

    private fun requestRequiredPermissions() {
        val candidates = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG
        )
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            candidates.add(Manifest.permission.PROCESS_OUTGOING_CALLS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            candidates.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val needed = candidates.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        } else {
            requestBackgroundLocationIfNeeded()
        }
    }

    private fun requestBackgroundLocationIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            hasForegroundLocation() &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            backgroundPermissionLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    private fun promptIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        }
    }
}
