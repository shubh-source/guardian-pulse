package com.guardianpulse.child

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

data class PendingCallUpload(
    val id: Long,
    val filePath: String,
    val direction: String,
    val phoneNumber: String,
    val startedAt: String,
    val endedAt: String,
    val durationSec: Int,
    val mimeType: String,
    val audioSource: String
)

/**
 * Temporary upload staging queue for call recordings.
 * Audio files stay in app cache only until uploaded to the Parent App,
 * then both the queue row and the temporary file are deleted immediately.
 */
class PendingUploadStore(context: Context) :
    SQLiteOpenHelper(context, "call_upload_queue.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS pending_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                direction TEXT NOT NULL,
                phone_number TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_sec INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                audio_source TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS pending_uploads")
        onCreate(db)
    }

    @Synchronized
    fun enqueue(
        filePath: String,
        direction: String,
        phoneNumber: String,
        startedAt: String,
        endedAt: String,
        durationSec: Int,
        mimeType: String,
        audioSource: String
    ) {
        val values = ContentValues().apply {
            put("file_path", filePath)
            put("direction", direction)
            put("phone_number", phoneNumber)
            put("started_at", startedAt)
            put("ended_at", endedAt)
            put("duration_sec", durationSec)
            put("mime_type", mimeType)
            put("audio_source", audioSource)
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insert("pending_uploads", null, values)
    }

    @Synchronized
    fun peekBatch(limit: Int = 20): List<PendingCallUpload> {
        val out = mutableListOf<PendingCallUpload>()
        readableDatabase.rawQuery(
            """
            SELECT id, file_path, direction, phone_number, started_at, ended_at,
                   duration_sec, mime_type, audio_source
            FROM pending_uploads
            ORDER BY id ASC
            LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(
                    PendingCallUpload(
                        id = cursor.getLong(0),
                        filePath = cursor.getString(1),
                        direction = cursor.getString(2),
                        phoneNumber = cursor.getString(3),
                        startedAt = cursor.getString(4),
                        endedAt = cursor.getString(5),
                        durationSec = cursor.getInt(6),
                        mimeType = cursor.getString(7),
                        audioSource = cursor.getString(8)
                    )
                )
            }
        }
        return out
    }

    @Synchronized
    fun deleteAndCleanup(item: PendingCallUpload) {
        writableDatabase.delete("pending_uploads", "id = ?", arrayOf(item.id.toString()))
        try {
            val f = File(item.filePath)
            if (f.exists()) f.delete()
        } catch (_: Exception) {
        }
    }

    @Synchronized
    fun count(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM pending_uploads", null).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    @Synchronized
    fun clearAll() {
        val items = peekBatch(500)
        for (item in items) {
            try {
                File(item.filePath).delete()
            } catch (_: Exception) {
            }
        }
        writableDatabase.delete("pending_uploads", null, null)
    }
}
