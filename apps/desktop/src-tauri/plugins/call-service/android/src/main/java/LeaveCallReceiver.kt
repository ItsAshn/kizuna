package com.kizuna.callservice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * "Leave call" on the ongoing-call notification. The page owns the call, so it
 * is told to leave and stops the service itself once it has. With no page
 * listening there is no call left to leave, so the service is stopped here.
 */
class LeaveCallReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_LEAVE = "com.kizuna.callservice.LEAVE"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_LEAVE) return
    val plugin = CallServicePlugin.instance
    if (plugin != null && plugin.hasListener(CallServicePlugin.EVENT_LEAVE)) {
      plugin.emitLeave()
    } else {
      context.stopService(Intent(context, CallService::class.java))
    }
  }
}
