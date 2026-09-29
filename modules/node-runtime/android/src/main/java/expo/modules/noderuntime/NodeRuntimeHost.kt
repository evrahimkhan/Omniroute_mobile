package expo.modules.noderuntime

import android.content.Context
import java.io.File
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

  fun gatewayDir(context: Context): File = File(context.filesDir, DIR_NAME)

  fun logPath(context: Context): String = File(gatewayDir(context), LOG_FILE_NAME).absolutePath

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
    "pid" to android.os.Process.myPid()
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
          appendToLog(
            request.logFilePath,
            "[node-runtime] starting node ${runtimeVersion()}: ${request.scriptPath}" +
              (if (request.args.isEmpty()) "" else " ${request.args.joinToString(" ")}")
          )
          val code = try {
            NodeRuntimeNative.nativeStart(argv, envPairs, request.workingDirectory, request.logFilePath)
          } catch (t: Throwable) {
            appendToLog(request.logFilePath, "[node-runtime] fatal: ${t.message}")
            FAILED_TO_START
          }
          appendToLog(request.logFilePath, "[node-runtime] node exited with code $code")
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
