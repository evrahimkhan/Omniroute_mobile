package expo.modules.noderuntime

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.pm.ApplicationInfo
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.io.RandomAccessFile
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * JNI surface of `libnoderuntime_jni.so`.
 *
 * The matching C functions live in `src/main/cpp/node-runtime-jni.cpp`; their
 * names are derived from this class, so renaming the object or the methods
 * means renaming the exported symbols there too.
 *
 * Both libraries are loaded eagerly and defensively: a build made without
 * `scripts/fetch-node-runtime.mjs` (a JS-only dev client, a web build, an ABI
 * that was never fetched) is a perfectly normal situation, and it must surface
 * as "unavailable" rather than as a crash at import time.
 *
 * Deliberately `private`, with accessors on the host: the JNI symbol names
 * (`Java_expo_modules_noderuntime_NodeRuntimeNative_nativeStart` in
 * `node-runtime-jni.cpp`) are derived from the JVM names of these methods, and
 * Kotlin mangles the JVM names of *internal* declarations. An `internal` object
 * here would link fine and then throw `UnsatisfiedLinkError` on the first call —
 * on a phone, with no build-time warning. Nothing outside this file needs the
 * native surface directly.
 */
private object NodeRuntimeNative {
  private val loadResult: Result<Unit> = runCatching {
    // libnode.so first: the shim links against it, so the dynamic linker has
    // to be able to resolve it before the shim is loaded.
    System.loadLibrary("node")
    System.loadLibrary("noderuntime_jni")
  }

  val loaded: Boolean get() = loadResult.isSuccess

  val loadError: String?
    get() = loadResult.exceptionOrNull()?.let { "${it.javaClass.simpleName}: ${it.message}" }

  external fun nativeVersion(): String

  external fun nativeStart(
    argv: Array<String>,
    envPairs: Array<String>,
    workingDirectory: String,
    logFilePath: String
  ): Int
}

/** One request to start the runtime, in the shape the app asked for it. */
internal data class RuntimeStartRequest(
  val scriptPath: String,
  val args: List<String>,
  val workingDirectory: String,
  val env: Map<String, String>,
  val logFilePath: String,
  val stackSizeMb: Int,
  /** Hold the app process alive (foreground service) while this runs. */
  val keepAlive: Boolean = false
)

/**
 * The process's one Node runtime, owned outside any Expo module.
 *
 * Why this is not just part of `NodeRuntimeModule`: nodejs-mobile allows exactly
 * one Node instance per process, and that instance has to outlive the app's UI.
 * Once the gateway is meant to keep serving while the app is closed, two
 * different things start it — the module (when the user taps "Install & start")
 * and `GatewayService` (when Android recreates the process after the service
 * restart). Both must go through the same state machine, or the second start
 * would either wedge or silently do nothing.
 *
 * State is process-wide and deliberately not resettable: when the runtime
 * exits, it is gone for this process (see docs/LOCAL_GATEWAY.md).
 */
internal object NodeRuntimeHost {
  private const val DIR_NAME = "node-runtime"
  private const val LOG_FILE_NAME = "node.log"

  /**
   * Where the markers below go, separately from [LOG_FILE_NAME].
   *
   * `node.log` is the process's captured stdout/stderr, so *everything* in the
   * app that writes there lands in it — Android WebView most of all. The app
   * needs the markers (was the script handed over? how did node end?) and they
   * must not be pushable out of a tail window by unrelated output, so they get
   * a file nothing else writes.
   */
  private const val RUNTIME_LOG_FILE_NAME = "runtime.log"
  private const val THREAD_NAME = "omniroute-node"
  private const val DEFAULT_STACK_MB = 8
  private const val MIN_STACK_MB = 2
  private const val MAX_STACK_MB = 64
  private const val MAX_LOG_BYTES = 8 * 1024 * 1024
  /** Kept in sync with `FAILED_TO_START` in node-runtime-jni.cpp. */
  private const val FAILED_TO_START = -1

  private val startedOnce = AtomicBoolean(false)

  @Volatile private var exitCode: Int? = null
  @Volatile private var startedAt: Long? = null
  @Volatile private var scriptPath: String? = null

  private val exitListeners = CopyOnWriteArrayList<(Int) -> Unit>()

  /** True when this build carries the runtime and it loaded. */
  val isAvailable: Boolean get() = NodeRuntimeNative.loaded

  /** Why the runtime is unavailable, or null when it loaded. */
  val unavailableReason: String?
    get() = NodeRuntimeNative.loadError

  /** Version reported by the embedded runtime. */
  fun runtimeVersion(): String =
    if (NodeRuntimeNative.loaded) NodeRuntimeNative.nativeVersion() else "unavailable"

  val isRunning: Boolean get() = startedOnce.get() && exitCode == null
  val hasExited: Boolean get() = exitCode != null
  val lastExitCode: Int? get() = exitCode
  val startedAtMillis: Long? get() = startedAt
  val currentScript: String? get() = scriptPath

  /** Called when the runtime exits, on the runtime's own thread. */
  fun addExitListener(listener: (Int) -> Unit) {
    exitListeners.add(listener)
  }

  fun removeExitListener(listener: (Int) -> Unit) {
    exitListeners.remove(listener)
  }

  /**
   * What the process is allowed and able to use, in one line.
   *
   * A runtime killed for memory leaves no message anywhere — no exception, no
   * stack, nothing in any log — so the numbers it was working under are the only
   * evidence available afterwards. Written before the runtime starts, into both
   * logs.
   */
  fun memoryFacts(context: Context): String {
    val runtime = Runtime.getRuntime()
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val info = ActivityManager.MemoryInfo()
    runCatching { activityManager?.getMemoryInfo(info) }
    val largeHeap = (context.applicationInfo.flags and ApplicationInfo.FLAG_LARGE_HEAP) != 0
    val heapMaxMb = runtime.maxMemory() / (1024 * 1024)
    val heapUsedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
    return "memory: heap limit ${heapMaxMb} MB, used ${heapUsedMb} MB, " +
      "device free ${info.availMem / (1024 * 1024)} MB of ${info.totalMem / (1024 * 1024)} MB, " +
      "lowMemory=${info.lowMemory}, largeHeap=$largeHeap"
  }

  /**
   * Why this app last ended abnormally, as Android recorded it — or null when
   * there is nothing abnormal to report.
   *
   * This is the answer to "the app just disappeared". A process killed for
   * memory, killed by a native crash, or killed for excessive resource use writes
   * nothing to any log and shows no error: it is simply gone, and everything the
   * app knows afterwards is that its runtime never exited. Android keeps the
   * reason for exactly this purpose (`ApplicationExitInfo`, API 30+), and it is
   * the difference between guessing at memory pressure and being told.
   *
   * Only abnormal endings are reported: "the user swiped it away" is not news,
   * and reporting it would bury the line that matters. A normal exit does *not*
   * clear the history, so the record can be older than the last run — which is
   * why the sentence carries the time it happened instead of claiming to be the
   * last run.
   */
  fun previousExit(context: Context): String? {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) return null
    return runCatching { previousExitFrom(context) }.getOrNull()
  }

  private fun previousExitFrom(context: Context): String? {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
    // (package, pid, maxNum): this app's own history, every pid, at most sixteen
    // records. The system keeps a short list per package, so the bound is nominal.
    //
    // Android 11 has a known bug where a query for the app's *own* package comes
    // back empty unless the app holds PACKAGE_USAGE_STATS; 12 and later answer
    // normally. Either way an empty list simply means there is nothing to report.
    val infos = manager.getHistoricalProcessExitReasons(context.packageName, 0, 16) ?: return null
    // The newest abnormal end, whatever order the system handed them over in.
    val info = infos
      .filter {
        it.reason != ApplicationExitInfo.REASON_USER_REQUESTED && it.reason != ApplicationExitInfo.REASON_OTHER
      }
      .maxByOrNull { it.timestamp }
      ?: return null

    val whenText = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(info.timestamp))
    val why = when (info.reason) {
      ApplicationExitInfo.REASON_LOW_MEMORY -> "the system killed it for memory"
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "it died in native code (signal ${info.status})"
      ApplicationExitInfo.REASON_CRASH -> "it crashed (Java)"
      ApplicationExitInfo.REASON_ANR -> "it stopped responding and was killed"
      ApplicationExitInfo.REASON_SIGNALED -> "it was killed by signal ${info.status}"
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "the system killed it for using too many resources"
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "it failed to start"
      ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "it was killed after a permission change"
      else -> "the system ended it (reason ${info.reason})"
    }
    val where = if (info.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
      "while it was in the foreground"
    } else {
      "while it was in the background"
    }
    val description = info.description?.takeIf { it.isNotBlank() }?.let { " — ${it.trim()}" } ?: ""
    return "the last abnormal exit was $whenText: $why ($where)$description"
  }

  fun gatewayDir(context: Context): File = File(context.filesDir, DIR_NAME)

  fun logPath(context: Context): String = File(gatewayDir(context), LOG_FILE_NAME).absolutePath

  fun runtimeLogPath(context: Context): String =
    File(gatewayDir(context), RUNTIME_LOG_FILE_NAME).absolutePath

  fun status(context: Context?): Map<String, Any?> = mapOf(
    "available" to NodeRuntimeNative.loaded,
    "running" to isRunning,
    "exited" to hasExited,
    "exitCode" to exitCode,
    "version" to if (NodeRuntimeNative.loaded) NodeRuntimeNative.nativeVersion() else "unavailable",
    "scriptPath" to scriptPath,
    "startedAt" to startedAt,
    "logFilePath" to context?.let { logPath(it) },
    "keepAlive" to GatewayService.isRunning(),
    "pid" to android.os.Process.myPid(),
    "previousExit" to context?.let { previousExit(it) }
  )

  fun readLog(context: Context, maxBytes: Int): String {
    val file = File(logPath(context))
    if (!file.isFile) return ""
    return tailOf(file, maxBytes.coerceIn(1, MAX_LOG_BYTES))
  }

  fun clearLog(context: Context) {
    val file = File(logPath(context))
    file.parentFile?.mkdirs()
    // writeText truncates, and creates the file if it is not there yet.
    file.writeText("")
  }

  fun appendToLog(logFilePath: String?, line: String) {
    if (logFilePath.isNullOrEmpty()) return
    runCatching { File(logFilePath).appendText("$line\n") }
  }

  /**
   * Record a runtime milestone where the app can always find it.
   *
   * Goes to `node.log` as well, so a crash report has the story in one file,
   * and to `runtime.log`, which is what the app reads back.
   */
  private fun markRuntime(context: Context, logFilePath: String?, line: String) {
    appendToLog(logFilePath, line)
    appendToLog(runtimeLogPath(context), line)
  }

  /**
   * Start the runtime on `request`.
   *
   * Throws [NodeRuntimeUnavailableException] when this build has no runtime, and
   * [NodeRuntimeStartException] when one has already been started (or the script
   * is missing). A failed *start* — as opposed to a runtime that later exits —
   * leaves the door open for a retry with better options.
   */
  fun start(context: Context, request: RuntimeStartRequest) {
    if (!NodeRuntimeNative.loaded) {
      throw NodeRuntimeUnavailableException(
        "Embedded Node runtime is not in this build (${NodeRuntimeNative.loadError ?: "unknown reason"}). " +
          "Run `npm run runtime:fetch` before building."
      )
    }
    if (!startedOnce.compareAndSet(false, true)) {
      throw NodeRuntimeStartException(
        "The Node runtime can only be started once per process (nodejs-mobile limitation). " +
          "Restart the app to start it again."
      )
    }

    try {
      val script = File(request.scriptPath)
      if (!script.isFile) throw NodeRuntimeStartException("Script not found: ${request.scriptPath}")

      val stackSizeMb = request.stackSizeMb.coerceIn(MIN_STACK_MB, MAX_STACK_MB)

      val env = LinkedHashMap<String, String>()
      // Android gives an app process no TMPDIR and there is no /tmp, so
      // os.tmpdir() — which node code calls freely — fails until this is set.
      // cacheDir is the right home for scratch data: the OS may reclaim it.
      env["TMPDIR"] = context.cacheDir.absolutePath
      // A lot of npm code calls os.homedir() unconditionally; on Android it is
      // unset. See docs/EMBEDDING.md in nodejs-mobile.
      env["HOME"] = context.filesDir.absolutePath
      env["NODE_ENV"] = "production"
      env.putAll(request.env)

      val argv = (listOf("node", request.scriptPath) + request.args).toTypedArray()
      val envPairs = env.map { (key, value) -> "$key=$value" }.toTypedArray()

      File(request.logFilePath).parentFile?.mkdirs()

      scriptPath = request.scriptPath
      startedAt = System.currentTimeMillis()

      val group = Thread.currentThread().threadGroup
      val worker = Thread(
        group,
        Runnable {
          // The app's copy of "the runtime was handed a script". Without it, a
          // runtime that starts and produces no output is indistinguishable
          // from one that never ran at all — which is exactly the confusion a
          // silent no-op exit (code 0, empty log) causes on the phone.
          markRuntime(context, request.logFilePath, "[node-runtime] ${memoryFacts(context)}")
          markRuntime(
            context,
            request.logFilePath,
            "[node-runtime] starting node ${runtimeVersion()}: ${request.scriptPath}" +
              (if (request.args.isEmpty()) "" else " ${request.args.joinToString(" ")}")
          )
          val code = try {
            NodeRuntimeNative.nativeStart(argv, envPairs, request.workingDirectory, request.logFilePath)
          } catch (t: Throwable) {
            markRuntime(context, request.logFilePath, "[node-runtime] fatal: ${t.message}")
            FAILED_TO_START
          }
          markRuntime(context, request.logFilePath, "[node-runtime] node exited with code $code")
          exitCode = code
          for (listener in exitListeners) {
            runCatching { listener(code) }
          }
        },
        THREAD_NAME,
        stackSizeMb.toLong() * 1024L * 1024L
      )
      // Not a daemon: the runtime should keep running for as long as the
      // process lives, independent of any JS thread.
      worker.isDaemon = false
      worker.start()
    } catch (t: Throwable) {
      // Let the caller retry after a bad-options failure.
      startedOnce.set(false)
      scriptPath = null
      startedAt = null
      throw t
    }
  }

  /** Last [limit] bytes of a file, as text — for reading long logs efficiently. */
  private fun tailOf(file: File, limit: Int): String = RandomAccessFile(file, "r").use { raf ->
    val start = if (raf.length() > limit) raf.length() - limit else 0L
    val buffer = ByteArray((raf.length() - start).toInt())
    raf.seek(start)
    raf.readFully(buffer)
    String(buffer, Charsets.UTF_8)
  }
}
