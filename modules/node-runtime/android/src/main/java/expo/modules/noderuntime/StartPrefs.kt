package expo.modules.noderuntime

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The last start request, kept across process death.
 *
 * A foreground service is what stops Android from reclaiming the app while the
 * gateway is serving, but it is not a guarantee: the user can force-stop the
 * app, and Android restarts a sticky service after a low-memory kill. On that
 * restart there is no JavaScript and no module — only this file. Without it the
 * service would come up with nothing to host and would have to stop, so the
 * gateway would silently disappear after an OS-initiated kill.
 *
 * It is written before the runtime starts (so a crash during start still
 * resumes) and cleared whenever the runtime exits or the user stops hosting, so
 * a restart never revives a gateway that was meant to be off.
 */
internal object StartPrefs {
  private const val FILE = "omniroute-gateway"
  private const val KEY_REQUEST = "startRequest"

  private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun save(context: Context, request: RuntimeStartRequest) {
    val json = JSONObject().apply {
      put("scriptPath", request.scriptPath)
      put("workingDirectory", request.workingDirectory)
      put("logFilePath", request.logFilePath)
      put("stackSizeMb", request.stackSizeMb)
      put("args", JSONArray(request.args))
      put("env", JSONObject(request.env))
    }
    prefs(context).edit().putString(KEY_REQUEST, json.toString()).apply()
  }

  fun read(context: Context): RuntimeStartRequest? {
    val raw = prefs(context).getString(KEY_REQUEST, null) ?: return null
    return runCatching {
      val json = JSONObject(raw)
      val env = json.optJSONObject("env")?.let { obj ->
        obj.keys().asSequence().associateWith { key -> obj.getString(key) }
      } ?: emptyMap()
      val args = json.optJSONArray("args")?.let { arr ->
        (0 until arr.length()).map { index -> arr.getString(index) }
      } ?: emptyList()
      RuntimeStartRequest(
        scriptPath = json.getString("scriptPath"),
        args = args,
        workingDirectory = json.getString("workingDirectory"),
        env = env,
        logFilePath = json.getString("logFilePath"),
        stackSizeMb = json.optInt("stackSizeMb", 8),
        keepAlive = true
      )
    }.getOrNull()
  }

  fun clear(context: Context) {
    prefs(context).edit().remove(KEY_REQUEST).apply()
  }
}
