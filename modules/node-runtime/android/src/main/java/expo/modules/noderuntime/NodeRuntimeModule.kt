package expo.modules.noderuntime

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile

/** The embedded runtime is missing or refused to load (wrong ABI, stripped APK). */
class NodeRuntimeUnavailableException(message: String) : CodedException(message)

/** Bad options, or an attempt to start a second runtime. */
class NodeRuntimeStartException(message: String) : CodedException(message)

/**
 * The app's view of the embedded Node.js runtime that hosts the OmniRoute
 * gateway on-device. See `docs/LOCAL_GATEWAY.md`.
 *
 * The runtime itself is owned by [NodeRuntimeHost], not by this module: it has
 * to survive the app being backgrounded (and, with keep-alive on, the process
 * being recreated by Android), so the module cannot be the thing that holds its
 * state. What is left here is the JS surface — options in, status and log out —
 * plus the filesystem access the app needs, because React Native has none.
 *
 * Lifecycle caveat, inherited from the runtime itself: nodejs-mobile supports
 * exactly one Node instance per process, and it cannot be restarted after it
 * exits. That is enforced in the host; the UI presents a restart as "reopen the
 * app".
 */
class NodeRuntimeModule : Module() {
  /**
   * Forward runtime exits to JavaScript. Registered for the module's lifetime
   * rather than per call, because the runtime outlives any single app session:
   * it can already be running when the app comes back to the foreground, and it
   * can exit while the app is closed.
   */
  private val onRuntimeExit: (Int) -> Unit = { code ->
    runCatching {
      sendEvent("onExit", mapOf("code" to code, "scriptPath" to NodeRuntimeHost.currentScript))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NodeRuntime")

    Events("onExit")

    OnCreate { NodeRuntimeHost.addExitListener(onRuntimeExit) }

    OnDestroy { NodeRuntimeHost.removeExitListener(onRuntimeExit) }

    Function("isAvailable") { NodeRuntimeHost.isAvailable }

    Function("getUnavailableReason") { NodeRuntimeHost.unavailableReason }

    Function("getRuntimeVersion") { NodeRuntimeHost.runtimeVersion() }

    Function("getStatus") { NodeRuntimeHost.status(appContext.reactContext) }

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

    /** End the gateway: stops the keep-alive service and the process hosting it. */
    Function("stopHosting") { reason: String -> stopHosting(reason) }

    AsyncFunction("readLog") { maxBytes: Int -> readLog(maxBytes) }

    AsyncFunction("clearLog") { clearLog() }
  }

  private fun appContextOrThrow(): Context =
    appContext.reactContext ?: throw NodeRuntimeStartException("No Android context available")

  private fun logPath(context: Context) = NodeRuntimeHost.logPath(context)

  private fun gatewayDir(context: Context) = NodeRuntimeHost.gatewayDir(context)

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
    val allowedRoots = listOf(context.filesDir, context.cacheDir)
    val allowed = allowedRoots.any { root ->
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

  /**
   * Turn the JS options into a start request and hand it to the host.
   *
   * With `foreground`, the service is started as well — in that order, so a
   * process death between the two still leaves a saved request to resume from
   * (and a runtime that is already running, which the service skips).
   */
  private fun startRuntime(options: Map<String, Any?>): Map<String, Any?> {
    val context = appContextOrThrow()

    val scriptPath = (options["scriptPath"] as? String)
      ?: throw NodeRuntimeStartException("scriptPath is required")
    val script = File(scriptPath)
    if (!script.isFile) throw NodeRuntimeStartException("Script not found: $scriptPath")

    val extraArgs = (options["args"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val workingDirectory = (options["workingDirectory"] as? String)
      ?: script.parentFile?.absolutePath
      ?: context.filesDir.absolutePath
    val logFilePath = (options["logFilePath"] as? String) ?: logPath(context)
    val stackSizeMb = ((options["stackSizeMb"] as? Number)?.toInt() ?: DEFAULT_STACK_MB)
    val keepAlive = (options["foreground"] as? Boolean) ?: false

    val env = LinkedHashMap<String, String>()
    (options["env"] as? Map<*, *>)?.forEach { (key, value) ->
      if (key is String && value != null) env[key] = value.toString()
    }

    val request = RuntimeStartRequest(
      scriptPath = scriptPath,
      args = extraArgs,
      workingDirectory = workingDirectory,
      env = env,
      logFilePath = logFilePath,
      stackSizeMb = stackSizeMb,
      keepAlive = keepAlive
    )

    // Written before the start, and removed again if the start fails: a request
    // that outlives a rejected start would make the service try to resume
    // something that never ran.
    if (keepAlive) StartPrefs.save(context, request)

    // The service goes first, so the process is foreground *while* the payload
    // boots. That boot is the most memory-hungry thing this app ever does, and an
    // Android process that is not foreground is the first one the system
    // reclaims. A service that cannot start (an oversize request, a
    // background-start restriction on some ROM) is a degraded outcome — hosting
    // only while the app is open — not a failed install, so it is logged and the
    // start carries on.
    var serviceStarted = false
    if (keepAlive) {
      serviceStarted =
        runCatching { GatewayService.start(context) }
          .onFailure { error ->
            NodeRuntimeHost.appendToLog(
              logFilePath,
              "[gateway] warning: could not start the background service (${error.message}); " +
                "the gateway runs only while the app is open"
            )
          }
          .isSuccess
    }

    try {
      NodeRuntimeHost.start(context, request)
    } catch (t: Throwable) {
      // Nothing is hosting, so leave nothing behind: no saved request, and no
      // notification claiming this phone is serving.
      if (keepAlive) {
        StartPrefs.clear(context)
        if (serviceStarted) runCatching { GatewayService.abandon(context) }
      }
      throw t
    }

    return NodeRuntimeHost.status(context)
  }

  /**
   * Stop hosting. The runtime cannot be shut down in-process, so this ends the
   * app process — see `GatewayService.requestStop`.
   */
  private fun stopHosting(reason: String) {
    GatewayService.requestStop(appContextOrThrow(), reason)
  }

  private fun readLog(maxBytes: Int): String {
    val context = appContext.reactContext
      ?: throw NodeRuntimeStartException("No Android context available")
    return NodeRuntimeHost.readLog(context, maxBytes.coerceIn(1, MAX_LOG_BYTES))
  }

  private fun clearLog() {
    val context = appContext.reactContext
      ?: throw NodeRuntimeStartException("No Android context available")
    NodeRuntimeHost.clearLog(context)
  }

  companion object {
  /**
   * Stack for the thread node runs on.
   *
   * The gateway is a Next.js server: tens of thousands of modules loaded through
   * a chain of C++ frames, and a native stack overflow is a SIGSEGV — the process
   * is gone with nothing written, which is exactly the death this is here to
   * avoid. Node's own `--stack-size` bounds *JavaScript* recursion; the frames
   * under it live on this stack, so the room has to be here. 8 MB was chosen
   * before the payload ever booted; 32 MB costs only address space, which a
   * 64-bit process has in abundance.
   */
    private const val DEFAULT_STACK_MB = 32
    private const val MAX_LOG_BYTES = 8 * 1024 * 1024
    private const val MAX_FILE_BYTES = 32 * 1024 * 1024
  }
}
