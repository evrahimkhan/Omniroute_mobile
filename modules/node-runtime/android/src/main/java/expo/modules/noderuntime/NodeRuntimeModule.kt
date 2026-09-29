package expo.modules.noderuntime

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

/** The embedded runtime is missing or refused to load (wrong ABI, stripped APK). */
class NodeRuntimeUnavailableException(message: String) : CodedException(message)

/** Bad options, or an attempt to start a second runtime. */
class NodeRuntimeStartException(message: String) : CodedException(message)

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

/**
 * Starts and supervises the embedded Node.js runtime that hosts the OmniRoute
 * gateway on-device. See `docs/LOCAL_GATEWAY.md`.
 *
 * Lifecycle caveat, inherited from the runtime itself: nodejs-mobile supports
 * exactly one Node instance per process, and it cannot be restarted after it
 * exits. This module enforces that — `start()` succeeds once per process, and
 * the UI is expected to present a restart as "restart the app".
 */
class NodeRuntimeModule : Module() {
  private val startedOnce = AtomicBoolean(false)

  @Volatile private var exitCode: Int? = null
  @Volatile private var startedAt: Long? = null
  @Volatile private var startedScript: String? = null

  override fun definition() = ModuleDefinition {
    Name("NodeRuntime")

    Events("onExit")

    Function("isAvailable") { NodeRuntimeNative.loaded }

    Function("getUnavailableReason") { NodeRuntimeNative.loadError }

    Function("getRuntimeVersion") {
      if (NodeRuntimeNative.loaded) NodeRuntimeNative.nativeVersion() else "unavailable"
    }

    Function("getStatus") { status() }

    Function("getPaths") { appPaths() }

    Function("fileExists") { path: String -> appFile(path).exists() }

    AsyncFunction("writeFile") { path: String, contents: String ->
      val file = appFile(path)
      file.parentFile?.mkdirs()
      file.writeText(contents)
      file.absolutePath
    }

    AsyncFunction("readFile") { path: String, maxBytes: Int ->
      val file = appFile(path)
      if (!file.isFile) {
        null
      } else {
        val limit = maxBytes.coerceIn(1, MAX_FILE_BYTES)
        if (file.length() <= limit) file.readText() else tailOf(file, limit)
      }
    }

    AsyncFunction("deleteDir") { path: String ->
      val dir = appFile(path)
      if (dir.exists()) dir.deleteRecursively() else true
    }

    AsyncFunction("start") { options: Map<String, Any?> -> startRuntime(options) }

    AsyncFunction("readLog") { maxBytes: Int -> readLog(maxBytes) }

    AsyncFunction("clearLog") { clearLog() }
  }

  private fun appContextOrThrow(): Context =
    appContext.reactContext ?: throw NodeRuntimeStartException("No Android context available")

  private fun logPath(context: Context) =
    File(gatewayDir(context), LOG_FILE_NAME).absolutePath

  private fun gatewayDir(context: Context) = File(context.filesDir, DIR_NAME)

  private fun appPaths(): Map<String, Any?> {
    val context = appContextOrThrow()
    return mapOf(
      "filesDir" to context.filesDir.absolutePath,
      "cacheDir" to context.cacheDir.absolutePath,
      "gatewayDir" to gatewayDir(context).absolutePath,
      "logFilePath" to logPath(context),
      "nativeLibraryDir" to context.applicationInfo.nativeLibraryDir
    )
  }

  /**
   * Resolve a path the app asked for, and refuse anything outside the app's own
   * storage. The app only ever passes paths it got from `getPaths()`, so a path
   * outside those roots means a bug — or something feeding us a path.
   *
   * Relative paths resolve against `filesDir`.
   */
  private fun appFile(path: String): File {
    val context = appContextOrThrow()
    val candidate = File(path).let { if (it.isAbsolute) it else File(context.filesDir, path) }
    val canonical = try {
      candidate.canonicalFile
    } catch (t: Throwable) {
      throw NodeRuntimeStartException("Unusable path: $path")
    }
    val allowed = listOf(context.filesDir, context.cacheDir).any { root ->
      val rootPath = root.canonicalFile.path
      canonical.path == rootPath || canonical.path.startsWith(rootPath + File.separator)
    }
    if (!allowed) {
      throw NodeRuntimeStartException("Path is outside the app's storage: $path")
    }
    return canonical
  }

  /** Last [limit] bytes of a file, as text — for reading long logs efficiently. */
  private fun tailOf(file: File, limit: Int): String = RandomAccessFile(file, "r").use { raf ->
    val start = if (raf.length() > limit) raf.length() - limit else 0L
    val buffer = ByteArray((raf.length() - start).toInt())
    raf.seek(start)
    raf.readFully(buffer)
    String(buffer, Charsets.UTF_8)
  }

  private fun status(): Map<String, Any?> {
    val context = appContext.reactContext
    val running = startedOnce.get() && exitCode == null
    return mapOf(
      "available" to NodeRuntimeNative.loaded,
      "running" to running,
      "exited" to (exitCode != null),
      "exitCode" to exitCode,
      "version" to if (NodeRuntimeNative.loaded) NodeRuntimeNative.nativeVersion() else "unavailable",
      "scriptPath" to startedScript,
      "startedAt" to startedAt,
      "logFilePath" to context?.let { logPath(it) },
      "pid" to android.os.Process.myPid()
    )
  }

  private fun startRuntime(options: Map<String, Any?>): Map<String, Any?> {
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
      val scriptPath = (options["scriptPath"] as? String)
        ?: throw NodeRuntimeStartException("scriptPath is required")
      val script = File(scriptPath)
      if (!script.isFile) throw NodeRuntimeStartException("Script not found: $scriptPath")

      val context = appContextOrThrow()
      val extraArgs = (options["args"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
      val workingDirectory = (options["workingDirectory"] as? String)
        ?: script.parentFile?.absolutePath
        ?: context.filesDir.absolutePath
      val logFilePath = (options["logFilePath"] as? String) ?: logPath(context)
      val stackSizeMb = ((options["stackSizeMb"] as? Number)?.toInt() ?: DEFAULT_STACK_MB)
        .coerceIn(MIN_STACK_MB, MAX_STACK_MB)

      val env = LinkedHashMap<String, String>()
      // Android gives an app process no TMPDIR and there is no /tmp, so
      // os.tmpdir() — which node code calls freely — fails until this is set.
      // cacheDir is the right home for scratch data: the OS may reclaim it.
      env["TMPDIR"] = context.cacheDir.absolutePath
      // A lot of npm code calls os.homedir() unconditionally; on Android it is
      // unset. See docs/EMBEDDING.md in nodejs-mobile.
      env["HOME"] = context.filesDir.absolutePath
      env["NODE_ENV"] = "production"
      (options["env"] as? Map<*, *>)?.forEach { (key, value) ->
        if (key is String && value != null) env[key] = value.toString()
      }

      val argv = (listOf("node", scriptPath) + extraArgs).toTypedArray()
      val envPairs = env.map { (key, value) -> "$key=$value" }.toTypedArray()

      File(logFilePath).parentFile?.mkdirs()

      startedScript = scriptPath
      startedAt = System.currentTimeMillis()

      val group = Thread.currentThread().threadGroup
      val worker = Thread(
        group,
        Runnable {
          val code = try {
            NodeRuntimeNative.nativeStart(argv, envPairs, workingDirectory, logFilePath)
          } catch (t: Throwable) {
            appendToLog(logFilePath, "[node-runtime] fatal: ${t.message}")
            FAILED_TO_START
          }
          exitCode = code
          sendEvent("onExit", mapOf("code" to code, "scriptPath" to scriptPath))
        },
        THREAD_NAME,
        stackSizeMb.toLong() * 1024L * 1024L
      )
      // Not a daemon: the runtime should keep running for as long as the
      // process lives, independent of any JS thread.
      worker.isDaemon = false
      worker.start()

      return status()
    } catch (t: Throwable) {
      // Let the caller retry after a bad-options failure.
      startedOnce.set(false)
      startedScript = null
      startedAt = null
      throw t
    }
  }

  private fun readLog(maxBytes: Int): String {
    val context = appContext.reactContext
      ?: throw NodeRuntimeStartException("No Android context available")
    val file = File(logPath(context))
    if (!file.isFile) return ""
    return tailOf(file, maxBytes.coerceIn(1, MAX_LOG_BYTES))
  }

  private fun clearLog() {
    val context = appContext.reactContext
      ?: throw NodeRuntimeStartException("No Android context available")
    val file = File(logPath(context))
    file.parentFile?.mkdirs()
    // writeText truncates, and creates the file if it is not there yet.
    file.writeText("")
  }

  private fun appendToLog(logFilePath: String, line: String) {
    runCatching {
      File(logFilePath).appendText("$line\n")
    }
  }

  companion object {
    private const val DIR_NAME = "node-runtime"
    private const val LOG_FILE_NAME = "node.log"
    private const val THREAD_NAME = "omniroute-node"
    private const val DEFAULT_STACK_MB = 8
    private const val MIN_STACK_MB = 2
    private const val MAX_STACK_MB = 64
    private const val MAX_LOG_BYTES = 8 * 1024 * 1024
    private const val MAX_FILE_BYTES = 32 * 1024 * 1024
    /** Kept in sync with `FAILED_TO_START` in node-runtime-jni.cpp. */
    private const val FAILED_TO_START = -1
  }
}
