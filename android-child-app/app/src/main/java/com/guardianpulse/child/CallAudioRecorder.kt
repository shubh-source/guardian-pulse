package com.guardianpulse.child

import android.content.Context
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.util.UUID

data class RecordedAudioResult(
    val file: File,
    val durationSec: Int,
    val mimeType: String,
    val audioSource: String
)

class CallAudioRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startedMs: Long = 0L
    private var activeSourceLabel: String = "mic"
    private var previousSpeakerState: Boolean? = null

    val isRecording: Boolean
        get() = recorder != null

    fun start(enableSpeakerBoost: Boolean): Boolean {
        if (recorder != null) return true

        val cacheDir = File(context.cacheDir, "pending_calls").apply { mkdirs() }
        val file = File(cacheDir, "call_${UUID.randomUUID()}.m4a")

        val sources = listOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION to "voice_recognition",
            MediaRecorder.AudioSource.MIC to "mic"
        )

        for ((source, label) in sources) {
            val candidate = createMediaRecorder()
            try {
                candidate.setAudioSource(source)
                candidate.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                candidate.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                candidate.setAudioEncodingBitRate(64_000)
                candidate.setAudioSamplingRate(16_000)
                candidate.setAudioChannels(1)
                candidate.setOutputFile(file.absolutePath)
                candidate.prepare()
                candidate.start()

                recorder = candidate
                outputFile = file
                startedMs = System.currentTimeMillis()
                activeSourceLabel = label

                if (enableSpeakerBoost) {
                    applySpeakerBoost(true)
                }
                return true
            } catch (_: Exception) {
                try {
                    candidate.reset()
                } catch (_: Exception) {
                }
                try {
                    candidate.release()
                } catch (_: Exception) {
                }
            }
        }

        if (file.exists()) file.delete()
        return false
    }

    fun stop(): RecordedAudioResult? {
        val active = recorder ?: return null
        val file = outputFile
        val durationSec = ((System.currentTimeMillis() - startedMs) / 1000L).toInt().coerceAtLeast(0)
        val sourceLabel = activeSourceLabel

        recorder = null
        outputFile = null
        restoreSpeakerBoost()

        try {
            active.stop()
        } catch (_: Exception) {
            try {
                active.reset()
            } catch (_: Exception) {
            }
            try {
                active.release()
            } catch (_: Exception) {
            }
            file?.delete()
            return null
        }

        try {
            active.release()
        } catch (_: Exception) {
        }

        if (file == null || !file.exists() || file.length() <= 0L) {
            file?.delete()
            return null
        }

        return RecordedAudioResult(
            file = file,
            durationSec = durationSec,
            mimeType = "audio/mp4",
            audioSource = sourceLabel
        )
    }

    private fun applySpeakerBoost(enable: Boolean) {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (previousSpeakerState == null) {
                @Suppress("DEPRECATION")
                previousSpeakerState = am.isSpeakerphoneOn
            }
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = enable
        } catch (_: Exception) {
        }
    }

    private fun restoreSpeakerBoost() {
        val prev = previousSpeakerState ?: return
        previousSpeakerState = null
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = prev
        } catch (_: Exception) {
        }
    }

    @Suppress("DEPRECATION")
    private fun createMediaRecorder(): MediaRecorder {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            MediaRecorder()
        }
    }
}
