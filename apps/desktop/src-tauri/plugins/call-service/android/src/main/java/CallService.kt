package com.kizuna.callservice

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps a voice call alive while the app is in the
 * background or the screen is off. It does no work itself: its only job is to
 * make the process a foreground one, which keeps the WebView's microphone
 * capture (and camera, while on) running.
 *
 * Android 14 rules: the service type passed to startForeground must be a
 * subset of the manifest's `microphone|camera`, and each type needs its
 * runtime permission already granted. The camera type is added only while the
 * camera is on, and dropped again when it goes off.
 */
class CallService : Service() {
  companion object {
    private const val TAG = "KizunaCallService"

    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_CAMERA = "camera"

    private const val CHANNEL_ID = "kizuna_ongoing_call"
    private const val NOTIFICATION_ID = 0x6b7a

    /** When the call started, so the notification's timer survives updates. */
    private var startedAt = 0L

    /** True while the service is in the foreground. */
    @Volatile
    var isRunning = false
      private set

    fun hasPermission(context: Context, permission: String): Boolean =
      ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (startedAt == 0L) startedAt = System.currentTimeMillis()

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.call_service_default_title)
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: getString(R.string.call_service_default_text)
    val camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) ?: false

    ensureChannel()
    val notification = buildNotification(title, text)

    // startForegroundService() obliges us to call startForeground() promptly,
    // so on a refused camera type fall back to microphone only rather than
    // not entering the foreground at all.
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType(camera))
      isRunning = true
    } catch (e: Exception) {
      Log.w(TAG, "startForeground with camera=$camera failed", e)
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType(false))
        isRunning = true
      } catch (e2: Exception) {
        Log.e(TAG, "startForeground failed, stopping", e2)
        stopSelf()
      }
    }

    // A call is never resumed by restarting the service on its own; the page
    // that owns the call is gone by then.
    return START_NOT_STICKY
  }

  /** Swiping the app away destroys the WebView and with it the call. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    isRunning = false
    startedAt = 0L
    super.onDestroy()
  }

  private fun serviceType(camera: Boolean): Int {
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (camera && hasPermission(this, Manifest.permission.CAMERA)) {
      type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    return type
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // Low importance: visible in the shade and status bar, but no sound or
    // heads-up every time a call starts.
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.call_service_channel_name),
      NotificationManager.IMPORTANCE_LOW
    )
    channel.description = getString(R.string.call_service_channel_description)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String): android.app.Notification {
    val immutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    // Same intent the launcher sends, so tapping brings the running task
    // forward instead of starting a second one.
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    }
    val contentIntent = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or immutable)
    }

    val leaveIntent = PendingIntent.getBroadcast(
      this,
      1,
      Intent(this, LeaveCallReceiver::class.java).setAction(LeaveCallReceiver.ACTION_LEAVE),
      PendingIntent.FLAG_UPDATE_CURRENT or immutable
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_call_service)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent)
      .addAction(0, getString(R.string.call_service_leave), leaveIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(true)
      .setWhen(startedAt)
      .setUsesChronometer(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      // Android 12+ otherwise holds a new foreground-service notification back
      // for up to ten seconds.
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
