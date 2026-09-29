/**
 * JNI bridge that runs the embedded Node.js runtime.
 *
 * Design notes (see docs/LOCAL_GATEWAY.md):
 *
 *  * `node::Start` is the entry point — it takes over the calling thread and
 *    only returns when the runtime exits. Kotlin calls this from a dedicated
 *    thread with a large stack, mirroring how the nodejs-mobile React Native
 *    plugin does it; V8 recurses deeply and a default-sized thread stack is
 *    not enough.
 *
 *  * Everything the runtime needs must be in place *before* `node::Start`:
 *    environment variables are read during bootstrap (NODE_OPTIONS, TMPDIR,
 *    NODE_ICU_DATA …), so setting them from JavaScript afterwards does nothing.
 *
 *  * stdout/stderr are redirected into a log file. On Android a native library
 *    has no console, so without this the runtime's output — including the
 *    reason it failed to boot — would go nowhere at all.
 *
 * If the prebuilt runtime was not placed in jniLibs (a JS-only dev client, or
 * an ABI that was never fetched), NODE_RUNTIME_AVAILABLE is 0 and this file
 * compiles to stubs that report failure instead of breaking the build.
 */

#include <jni.h>
#include <android/log.h>
#include <fcntl.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define LOG_TAG "NodeRuntimeJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#ifndef NODE_RUNTIME_AVAILABLE
#define NODE_RUNTIME_AVAILABLE 1
#endif

#if NODE_RUNTIME_AVAILABLE
#include "node.h"
#if __has_include("node_version.h")
#include "node_version.h"
#endif
#endif

namespace {

/** Sent to Kotlin when the runtime could not be started at all. */
constexpr int kFailedToStart = -1;
/** Sent to Kotlin when the runtime has already been started in this process. */
constexpr int kAlreadyStarted = -2;
/** Sent to Kotlin when this build has no embedded runtime. */
constexpr int kNotAvailable = -3;

bool g_started = false;

#if NODE_RUNTIME_AVAILABLE
const char *nodeVersionString() {
#if defined(NODE_VERSION)
  return NODE_VERSION;
#elif defined(NODE_MAJOR_VERSION) && defined(NODE_MINOR_VERSION) && defined(NODE_PATCH_VERSION)
#define NODE_STRINGIFY_(x) #x
#define NODE_STRINGIFY(x) NODE_STRINGIFY_(x)
  return "v" NODE_STRINGIFY(NODE_MAJOR_VERSION) "." NODE_STRINGIFY(
      NODE_MINOR_VERSION) "." NODE_STRINGIFY(NODE_PATCH_VERSION);
#else
  return "unknown";
#endif
}
#else
const char *nodeVersionString() { return "unavailable"; }
#endif

/** Copy a jstring into a std::string (empty when null). */
std::string toString(JNIEnv *env, jstring value) {
  if (value == nullptr) return {};
  const char *chars = env->GetStringUTFChars(value, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(value, chars);
  return out;
}

/** Copy a String[] into a vector<std::string>. */
std::vector<std::string> toStringVector(JNIEnv *env, jobjectArray array) {
  std::vector<std::string> out;
  if (array == nullptr) return out;
  const jsize count = env->GetArrayLength(array);
  out.reserve(static_cast<size_t>(count));
  for (jsize i = 0; i < count; ++i) {
    auto element = reinterpret_cast<jstring>(env->GetObjectArrayElement(array, i));
    out.push_back(toString(env, element));
    if (element != nullptr) env->DeleteLocalRef(element);
  }
  return out;
}

/** The descriptors the app had before the redirect, so they can be restored. */
int g_savedStdout = -1;
int g_savedStderr = -1;

/** Defined below, next to the redirect it undoes. */
void restoreStdio();

/** Point fd 1 and fd 2 at a file, so the runtime's output survives. */
bool redirectStdioTo(const std::string &path) {
  int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) {
    LOGE("cannot open log file %s: %s", path.c_str(), strerror(errno));
    return false;
  }
  g_savedStdout = dup(STDOUT_FILENO);
  g_savedStderr = dup(STDERR_FILENO);
  if (dup2(fd, STDOUT_FILENO) < 0 || dup2(fd, STDERR_FILENO) < 0) {
    LOGE("dup2 failed: %s", strerror(errno));
    close(fd);
    restoreStdio();
    return false;
  }
  if (fd > STDERR_FILENO) close(fd);
  // Replace whatever buffering the streams inherited from the app process.
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  return true;
}

/**
 * Put the app's own stdout/stderr back once the runtime is over.
 *
 * The redirect is process-wide, so leaving it in place means everything else in
 * the app that writes to stderr keeps landing in the runtime log — Android
 * WebView most visibly, which logs a steady stream of its own. That is how a
 * file meant to hold a crash report filled with browser chatter *after* node had
 * already exited, and it is why the app now keeps the gateway's own log
 * separately (`gateway.log`).
 */
void restoreStdio() {
  if (g_savedStdout >= 0) {
    dup2(g_savedStdout, STDOUT_FILENO);
    close(g_savedStdout);
    g_savedStdout = -1;
  }
  if (g_savedStderr >= 0) {
    dup2(g_savedStderr, STDERR_FILENO);
    close(g_savedStderr);
    g_savedStderr = -1;
  }
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_noderuntime_NodeRuntimeNative_nativeVersion(JNIEnv *env, jobject /* thiz */) {
  return env->NewStringUTF(nodeVersionString());
}

/**
 * Blocking: runs the Node runtime on the calling thread and returns its exit
 * code. Kotlin is responsible for calling this off the main thread.
 */
extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_noderuntime_NodeRuntimeNative_nativeStart(
    JNIEnv *env,
    jobject /* thiz */,
    jobjectArray argvArray,
    jobjectArray envArray,
    jstring workingDirectory,
    jstring logFilePath) {
#if !NODE_RUNTIME_AVAILABLE
  LOGE("no embedded Node runtime in this build (ABI was not fetched)");
  (void) argvArray;
  (void) envArray;
  (void) workingDirectory;
  (void) logFilePath;
  return kNotAvailable;
#else
  if (g_started) {
    LOGE("the Node runtime can only be started once per process");
    return kAlreadyStarted;
  }
  g_started = true;

  const std::string cwd = toString(env, workingDirectory);
  const std::string logPath = toString(env, logFilePath);
  const std::vector<std::string> argStrings = toStringVector(env, argvArray);
  const std::vector<std::string> envPairs = toStringVector(env, envArray);

  if (argStrings.empty()) {
    LOGE("refusing to start node without an entry script");
    return kFailedToStart;
  }

  // Environment first: node reads these during bootstrap.
  for (const auto &pair : envPairs) {
    const size_t eq = pair.find('=');
    if (eq == std::string::npos || eq == 0) continue;
    setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
  }

  if (!logPath.empty() && !redirectStdioTo(logPath)) {
    LOGI("continuing without stdio redirection");
  }

  if (!cwd.empty()) {
    if (chdir(cwd.c_str()) != 0) {
      LOGE("chdir(%s) failed: %s", cwd.c_str(), strerror(errno));
    }
  }

  LOGI("starting node %s with %zu argument(s)", nodeVersionString(), argStrings.size());

  // node::Start wants mutable C strings and a NULL-terminated argv.
  std::vector<char *> argv;
  argv.reserve(argStrings.size() + 1);
  for (const auto &arg : argStrings) argv.push_back(strdup(arg.c_str()));
  argv.push_back(nullptr);

  const int exitCode = node::Start(static_cast<int>(argStrings.size()), argv.data());

  restoreStdio();
  for (char *arg : argv) free(arg);
  LOGI("node exited with code %d", exitCode);
  return exitCode;
#endif
}
