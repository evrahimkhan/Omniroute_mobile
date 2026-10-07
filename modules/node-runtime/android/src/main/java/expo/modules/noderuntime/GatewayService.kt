package expo.modules.noderuntime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process

/**
 * Keeps the gateway's process alive while the app is in the background.
 *
 * "Hosting OmniRoute on the phone" only means something if the gateway is still
 * serving when the app is not on screen: without this, Android treats the
 * process as a cached background process and reclaims it within minutes, taking
 * the embedded runtime with it. A foreground service makes the process a
 * first-class, user-visible one, so the runtime it hosts keeps running with the
 * app closed, the screen off, or the task swiped away.
 *
 * Two responsibilities, kept deliberately small:
 *
 *   1. hold the process alive, with the notification Android requires for that
 *      (which doubles as the user's status line — it shows the newest line the
 *      bootstrap printed, so a first-run download is visible from the shade);
 *   2. resume the runtime if the process was recreated underneath it, using the
 *      request persisted in [StartPrefs] when the user first started hosting.
 *
 * The runtime itself stays in [NodeRuntimeHost]: this service never parses a
 * payload, and nothing here needs JavaScript to be running.
 *
 * See docs/LOCAL_GATEWAY.md §5e.
 */
class GatewayService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var foregroundStarted = false
  private var port: Int = DEFAULT_PORT

  /**
   * Node is gone, so there is nothing left to protect: report it and stand
   * down. The saved request is cleared as well, so a later process restart
   * does not revive a gateway that already exited.
   */
  // Annotated on purpose: the body's last expression is `handler.post`, which
  // returns Boolean, so an unannotated lambda would be `(Int) -> Boolean` and
  // could not be registered as an exit listener.
  private val onExit: (Int) -> Unit = { code: Int ->
    handler.post {
      runCatching { notificationManager()?.notify(NOTIFICATION_ID, buildNotification("Stopped (exit $code)")) }
      // Do not resurrect a gateway that has already exited: a stale request
      // would otherwise restart a broken install on every process restart.
      StartPrefs.clear(this)
      stopForegroundCompat()
      stopSelf()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    NodeRuntimeHost.addExitListener(onExit)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopHosting(intent.getStringExtra(EXTRA_REASON) ?: "[gateway] stopped by the user")
      return START_NOT_STICKY
    }

    port = StartPrefs.read(this)?.env?.get("GATEWAY_PORT")?.toIntOrNull() ?: DEFAULT_PORT
    // Android allows five seconds between startForegroundService() and
    // startForeground(); everything else happens after this call.
    goForeground("Starting the gateway…")

    if (!NodeRuntimeHost.isRunning) {
      // Either the module just started the runtime (nothing to do), or Android
      // recreated the process and this is the only thing left that knows what
      // the gateway was running.
      val request = StartPrefs.read(this)
      if (request == null) {
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      runCatching { NodeRuntimeHost.start(this, request) }
        .onFailure { error ->
          NodeRuntimeHost.appendToLog(
            request.logFilePath,
            "[gateway] FAILED: the background service could not restart the gateway: ${error.message}"
          )
          StartPrefs.clear(this)
          runCatching {
            notificationManager()?.notify(NOTIFICATION_ID, buildNotification("Could not restart the gateway"))
          }
          stopForegroundCompat()
          stopSelf()
        }
    }

    scheduleStatusUpdates()
    // Sticky as well as foreground: a low-memory kill comes back with a null
    // intent, which lands in this same branch, and the saved request resumes.
    return START_STICKY
  }

  override fun onDestroy() {
    NodeRuntimeHost.removeExitListener(onExit)
    handler.removeCallbacksAndMessages(null)
    foregroundStarted = false
    running = false
    super.onDestroy()
  }

  /**
   * Stop hosting for good.
   *
   * The Node runtime cannot be shut down from inside the process — nodejs-mobile
   * has no stop API, and the thread is deliberately not a daemon — so the only
   * honest way to stop a gateway is to end the process that hosts it. Android
   * restarts the app cleanly on the next launch.
   */
  private fun stopHosting(reason: String) {
    NodeRuntimeHost.appendToLog(NodeRuntimeHost.logPath(this), reason)
    StartPrefs.clear(this)
    handler.removeCallbacksAndMessages(null)
    stopForegroundCompat()
    stopSelf()
    Process.killProcess(Process.myPid())
  }

  // ---------------------------------------------------------------- notification

  private fun notificationManager(): NotificationManager? =
    getSystemService(NotificationManager::class.java)

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = notificationManager() ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Local gateway", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while this phone hosts an OmniRoute gateway."
        setShowBadge(false)
      }
    )
  }

  /**
   * `IMMUTABLE` is required on Android 12+: the system throws when a
   * PendingIntent without an explicit mutability flag is created.
   */
  private fun pendingIntentFlags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }

  private fun buildNotification(text: String): Notification {
    ensureChannel()

    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openIntent?.let {
      PendingIntent.getActivity(this, REQUEST_OPEN, it, pendingIntentFlags())
    }
    val stopIntent = PendingIntent.getService(
      this,
      REQUEST_STOP,
      Intent(this, GatewayService::class.java)
        .setAction(ACTION_STOP)
        .putExtra(EXTRA_REASON, "[gateway] stopped from the notification"),
      pendingIntentFlags()
    )
    val stopAction = Notification.Action.Builder(null, "Stop", stopIntent).build()

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
    }

    return builder
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("OmniRoute gateway")
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .apply { contentIntent?.let { setContentIntent(it) } }
      .addAction(stopAction)
      .build()
  }

  private fun goForeground(text: String) {
    val notification = buildNotification(text)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundStarted = true
    running = true
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      stopForeground(true)
    }
    foregroundStarted = false
  }

  /**
   * Show what the gateway is doing, without parsing anything.
   *
   * The text is the newest line the bootstrap printed, verbatim (its `[gateway]`
   * prefix stripped). Translating those lines into nicer wording would mean a
   * second parser on the Kotlin side of the same log — which is exactly how the
   * app's parser and the bootstrap drifted apart twice (see §5d) — so the
   * notification repeats the line instead of interpreting it.
   */
  private fun scheduleStatusUpdates() {
    val tick = object : Runnable {
      override fun run() {
        if (!foregroundStarted) return
        runCatching { notificationManager()?.notify(NOTIFICATION_ID, buildNotification(statusText())) }
        handler.postDelayed(this, STATUS_INTERVAL_MS)
      }
    }
    handler.postDelayed(tick, STATUS_INTERVAL_MS)
  }

  private fun statusText(): String {
    if (NodeRuntimeHost.hasExited) return "Stopped (exit ${NodeRuntimeHost.lastExitCode ?: "?"})"
    val line = lastBootstrapLine()
    if (line != null) return line
    return "Running on 127.0.0.1:$port"
  }

  private fun lastBootstrapLine(): String? {
    val log = runCatching { NodeRuntimeHost.readLog(this, LOG_TAIL_BYTES) }.getOrNull() ?: return null
    val lines = log.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
    val gatewayLine = lines.lastOrNull { it.startsWith(GATEWAY_PREFIX) } ?: return null
    val text = gatewayLine.removePrefix(GATEWAY_PREFIX).trim()
    return text.take(MAX_STATUS_CHARS).ifEmpty { null }
  }

  // --------------------------------------------------------------------- statics

  companion object {
    const val ACTION_START = "expo.modules.noderuntime.action.START"
    const val ACTION_STOP = "expo.modules.noderuntime.action.STOP"

    private const val EXTRA_REASON = "reason"
    private const val CHANNEL_ID = "omniroute-gateway"
    private const val NOTIFICATION_ID = 8080
    private const val REQUEST_OPEN = 0
    private const val REQUEST_STOP = 1
    private const val DEFAULT_PORT = 8080
    private const val STATUS_INTERVAL_MS = 3000L
    private const val LOG_TAIL_BYTES = 4096
    private const val MAX_STATUS_CHARS = 120
    private const val GATEWAY_PREFIX = "[gateway]"

    @Volatile private var running = false

    /** True while this process is being held alive for the gateway. */
    fun isRunning(): Boolean = running

    /** Start (or refresh) the keep-alive service. Safe to call repeatedly. */
    fun start(context: Context) {
      val intent = Intent(context, GatewayService::class.java).setAction(ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /**
     * Stop the keep-alive service, but not the process.
     *
     * For the case where the service is already up and the runtime then fails to
     * start: there is nothing to host, so the notification must go — but the app
     * itself is fine, and the caller is about to hand an error back to the user.
     * `requestStop` would be wrong here: it ends the process, which would turn a
     * recoverable start failure into a crash.
     */
    fun abandon(context: Context) {
      if (!running) return
      runCatching { context.stopService(Intent(context, GatewayService::class.java)) }
      running = false
    }

    /**
     * End the gateway, from either the notification or the app.
     *
     * If the service is not running there is nothing to notify, so the process
     * ends directly — the runtime cannot be stopped any other way.
     */
    fun requestStop(context: Context, reason: String) {
      if (running) {
        context.startService(
          Intent(context, GatewayService::class.java)
            .setAction(ACTION_STOP)
            .putExtra(EXTRA_REASON, reason)
        )
      } else {
        NodeRuntimeHost.appendToLog(NodeRuntimeHost.logPath(context), reason)
        Process.killProcess(Process.myPid())
      }
    }
  }
}
