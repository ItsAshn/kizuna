package com.kizuna.callservice

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class CallServiceArgs {
  var title: String? = null
  var text: String? = null
  var camera: Boolean = false
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
  ]
)
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    const val EVENT_LEAVE = "leave"

    /** The live plugin, for the notification's Leave action to reach the page. */
    @Volatile
    var instance: CallServicePlugin? = null
  }

  private var webView: WebView? = null

  init {
    instance = this
  }

  override fun load(webView: WebView) {
    this.webView = webView
  }

  /**
   * The activity pauses its WebView whenever it leaves the screen, which marks
   * the page hidden. During a call, undo that so the page keeps behaving as
   * if in front: capture and playback carry on rather than depending on how
   * a given WebView version treats hidden pages. This runs on the process
   * lifecycle, shortly after the activity's own pause.
   */
  override fun onPause() {
    if (CallService.isRunning) webView?.onResume()
  }

  /**
   * Start the service (or refresh it if already running). On Android 13+ the
   * notification permission is asked for first; the call is kept alive either
   * way, since a denied permission only hides the notification.
   */
  @Command
  fun start(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      !CallService.hasPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
    ) {
      requestPermissionForAlias("notifications", invoke, "startAfterPermission")
      return
    }
    startService(invoke)
  }

  @PermissionCallback
  private fun startAfterPermission(invoke: Invoke) {
    startService(invoke)
  }

  /** Like start, but never prompts; used when the camera turns on or off. */
  @Command
  fun update(invoke: Invoke) {
    startService(invoke)
  }

  @Command
  fun stop(invoke: Invoke) {
    activity.stopService(Intent(activity, CallService::class.java))
    invoke.resolve()
  }

  fun emitLeave() {
    trigger(EVENT_LEAVE, JSObject())
  }

  override fun onDestroy() {
    // The WebView goes with the activity, and the call with it.
    activity.stopService(Intent(activity, CallService::class.java))
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun startService(invoke: Invoke) {
    // A microphone-type foreground service cannot start without the
    // permission, and failing inside the service after
    // startForegroundService() would crash the app.
    if (!CallService.hasPermission(activity, Manifest.permission.RECORD_AUDIO)) {
      invoke.reject("Microphone permission not granted")
      return
    }
    val args = invoke.parseArgs(CallServiceArgs::class.java)
    val intent = Intent(activity, CallService::class.java).apply {
      putExtra(CallService.EXTRA_TITLE, args.title)
      putExtra(CallService.EXTRA_TEXT, args.text)
      putExtra(CallService.EXTRA_CAMERA, args.camera)
    }
    try {
      // Throws on Android 12+ if the app is already in the background.
      ContextCompat.startForegroundService(activity, intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Could not start the call service: ${e.message}")
    }
  }
}
