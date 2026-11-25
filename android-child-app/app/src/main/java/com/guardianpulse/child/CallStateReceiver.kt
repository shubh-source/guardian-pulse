package com.guardianpulse.child

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

class CallStateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = PrefsStore(context)
        if (!prefs.isPaired || !prefs.trackingActive || !prefs.callRecordingEnabled) return

        when (intent.action) {
            @Suppress("DEPRECATION")
            Intent.ACTION_NEW_OUTGOING_CALL -> {
                @Suppress("DEPRECATION")
                val outgoingNumber = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER)
                val svc = Intent(context, CallRecorderService::class.java).apply {
                    action = CallRecorderService.ACTION_OUTGOING_NUMBER
                    putExtra(CallRecorderService.EXTRA_PHONE_NUMBER, outgoingNumber)
                }
                startServiceSafely(context, svc)
            }
            TelephonyManager.ACTION_PHONE_STATE_CHANGED -> {
                val stateStr = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
                val stateInt = when (stateStr) {
                    TelephonyManager.EXTRA_STATE_RINGING -> TelephonyManager.CALL_STATE_RINGING
                    TelephonyManager.EXTRA_STATE_OFFHOOK -> TelephonyManager.CALL_STATE_OFFHOOK
                    TelephonyManager.EXTRA_STATE_IDLE -> TelephonyManager.CALL_STATE_IDLE
                    else -> return
                }
                @Suppress("DEPRECATION")
                val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
                val svc = Intent(context, CallRecorderService::class.java).apply {
                    action = CallRecorderService.ACTION_PHONE_STATE_UPDATE
                    putExtra(CallRecorderService.EXTRA_CALL_STATE, stateInt)
                    putExtra(CallRecorderService.EXTRA_PHONE_NUMBER, number)
                }
                startServiceSafely(context, svc)
            }
        }
    }

    private fun startServiceSafely(context: Context, intent: Intent) {
        try {
            ContextCompat.startForegroundService(context, intent)
        } catch (_: Exception) {
        }
    }
}
