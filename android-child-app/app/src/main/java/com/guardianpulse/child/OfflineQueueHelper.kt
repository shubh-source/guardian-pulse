package com.guardianpulse.child

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class OfflineQueueHelper(context: Context) :
    SQLiteOpenHelper(context, "gp_offline_queue.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS queued_locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS queued_locations")
        onCreate(db)
    }

    fun enqueue(point: JSONObject) {
        val db = writableDatabase
        val values = ContentValues().apply {
            put("payload_json", point.toString())
            put("created_at", System.currentTimeMillis())
        }
        db.insert("queued_locations", null, values)
        // Keep queue bounded at 10,000 points
        db.execSQL(
            """
            DELETE FROM queued_locations
            WHERE id NOT IN (
                SELECT id FROM queued_locations ORDER BY id DESC LIMIT 10000
            )
            """.trimIndent()
        )
    }

    fun peekBatch(limit: Int = 100): List<Pair<Long, JSONObject>> {
        val list = mutableListOf<Pair<Long, JSONObject>>()
        val db = readableDatabase
        db.rawQuery(
            "SELECT id, payload_json FROM queued_locations ORDER BY id ASC LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val obj = JSONObject(cursor.getString(1))
                list.add(id to obj)
            }
        }
        return list
    }

    fun deleteIds(ids: List<Long>) {
        if (ids.isEmpty()) return
        val placeholders = ids.joinToString(",") { "?" }
        val args = ids.map { it.toString() }.toTypedArray()
        writableDatabase.delete("queued_locations", "id IN ($placeholders)", args)
    }

    fun count(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM queued_locations", null).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    fun clearAll() {
        writableDatabase.delete("queued_locations", null, null)
    }
}
