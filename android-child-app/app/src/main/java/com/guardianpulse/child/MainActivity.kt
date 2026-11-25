package com.guardianpulse.child

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
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
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: PrefsStore
    private lateinit var queue: OfflineQueueHelper
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
    private lateinit var toggleButton: Button
    private lateinit var permissionsButton: Button
    private lateinit var unpairButton: Button

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        requestBackgroundLocationIfNeeded()
        if (prefs.isPaired && prefs.trackingActive && hasForegroundLocation()) {
            LocationTrackingService.start(this)
        }
    }

    private val backgroundPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        if (prefs.isPaired && prefs.trackingActive && hasForegroundLocation()) {
            LocationTrackingService.start(this)
        }
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
        toggleButton = findViewById(R.id.toggleButton)
        permissionsButton = findViewById(R.id.permissionsButton)
        unpairButton = findViewById(R.id.unpairButton)

        serverUrlInput.setText(prefs.serverUrl)
        deviceNameInput.setText(Build.MODEL ?: "Android Phone")

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
            LocationTrackingService.start(this)
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
                    if (hasForegroundLocation()) {
                        LocationTrackingService.start(this)
                    }
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
            LocationTrackingService.start(this)
        } else {
            LocationTrackingService.stop(this)
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
        prefs.clearPairing()
        queue.clearAll()
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
            statusTitle.text = "24/7 Location Sharing Active"
            statusTitle.setTextColor(0xFF10B981.toInt())
            toggleButton.text = "Pause Sharing"
        } else {
            statusTitle.text = "Location Sharing Paused"
            statusTitle.setTextColor(0xFFF59E0B.toInt())
            toggleButton.text = "Resume Sharing"
        }

        sharedWithLabel.text =
            "Child: ${prefs.childName} · Parent: ${prefs.parentName} (${prefs.deviceName})"
        telemetryCoords.text = "Last fix: ${prefs.lastSummary}"
        telemetrySync.text = "Last synced: ${prefs.lastSyncedAt} · Offline queue: ${queue.count()}"
    }

    private fun hasForegroundLocation(): Boolean {
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestRequiredPermissions() {
        val needed = mutableListOf<String>()
        if (!hasForegroundLocation()) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
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
