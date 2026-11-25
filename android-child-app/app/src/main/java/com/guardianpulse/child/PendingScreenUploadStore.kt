package com.guardianpulse.child

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

data class PendingScreenUpload(
    val id: Long,
    val filePath: String,
    val startedAt: String,
    val endedAt: String,
    val durationSec: Int,
    val width: Int,
    val height: Int,
    val fps: Int,
    val mimeType: String
)

/**
 * Temporary upload staging queue for screen recording video clips.
 * Clips stay in app cache only until uploaded to the Parent App,
 * then both the queue row and the temporary .mp4 file are deleted immediately.
 */
class PendingScreenUploadStore(context: Context) :
    SQLiteOpenHelper(context, "screen_upload_queue.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS pending_screen_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_sec INTEGER NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                fps INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS pending_screen_uploads")
        onCreate(db)
    }

    @Synchronized
    fun enqueue(
        filePath: String,
        startedAt: String,
        endedAt: String,
        durationSec: Int,
        width: Int,
        height: Int,
        fps: Int,
        mimeType: String = "video/mp4"
    ) {
        val values = ContentValues().apply {
            put("file_path", filePath)
            put("started_at", startedAt)
            put("ended_at", endedAt)
            put("duration_sec", durationSec)
            put("width", width)
            put("height", height)
            put("fps", fps)
            put("mime_type", mimeType)
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insert("pending_screen_uploads", null, values)
        trimExcessLocked()
    }

    @Synchronized
    fun peekBatch(limit: Int = 10): List<PendingScreenUpload> {
        val out = mutableListOf<PendingScreenUpload>()
        readableDatabase.rawQuery(
            """
            SELECT id, file_path, started_at, ended_at, duration_sec,
                   width, height, fps, mime_type
            FROM pending_screen_uploads
            ORDER BY id ASC
            LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(
                    PendingScreenUpload(
                        id = cursor.getLong(0),
                        filePath = cursor.getString(1),
                        startedAt = cursor.getString(2),
                        endedAt = cursor.getString(3),
                        durationSec = cursor.getInt(4),
                        width = cursor.getInt(5),
                        height = cursor.getInt(6),
                        fps = cursor.getInt(7),
                        mimeType = cursor.getString(8)
                    )
                )
            }
        }
        return out
    }

    @Synchronized
    fun deleteAndCleanup(item: PendingScreenUpload) {
        writableDatabase.delete("pending_screen_uploads", "id = ?", arrayOf(item.id.toString()))
        try {
            val f = File(item.filePath)
            if (f.exists()) f.delete()
        } catch (_: Exception) {
        }
    }

    @Synchronized
    fun count(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM pending_screen_uploads", null).use { cursor ->
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
        writableDatabase.delete("pending_screen_uploads", null, null)
    }

    private fun trimExcessLocked() {
        val total = count()
        if (total <= MAX_QUEUED_CLIPS) return
        val toDrop = peekBatch(total - MAX_QUEUED_CLIPS)
        for (item in toDrop) {
            deleteAndCleanup(item)
        }
    }

    companion object {
        private const val MAX_QUEUED_CLIPS = 40
    }
}
