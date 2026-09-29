cmake_minimum_required(VERSION 3.22.1)
project(noderuntime_jni CXX)

# Node's public headers are C++20 (they use `concept`/`requires` and
# std::contiguous_iterator_tag, which only exist in C++20 mode). Compiling them
# as C++17 fails inside v8/cppgc before it ever reaches this file.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The prebuilt runtime, placed by `npm run runtime:fetch`
# (scripts/fetch-node-runtime.mjs) at:
#   src/main/jniLibs/<abi>/libnode.so   ← packaged into the APK
#   src/main/cpp/include/               ← node.h, v8.h, uv/… (the archive's
#                                          include tree, prefix stripped)
#
# The upstream archive keeps the public headers in an `include/node/`
# subdirectory (Node's conventional install layout), but a flatter tree is
# possible, so accept either.
set(NODE_RUNTIME_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")
set(NODE_RUNTIME_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/include")

set(NODE_RUNTIME_INCLUDE_DIRS "${NODE_RUNTIME_INCLUDE}")
set(NODE_RUNTIME_HEADER "")
foreach(candidate "${NODE_RUNTIME_INCLUDE}/node.h" "${NODE_RUNTIME_INCLUDE}/node/node.h")
  if(EXISTS "${candidate}")
    set(NODE_RUNTIME_HEADER "${candidate}")
    get_filename_component(candidate_dir "${candidate}" DIRECTORY)
    list(APPEND NODE_RUNTIME_INCLUDE_DIRS "${candidate_dir}")
  endif()
endforeach()

if(EXISTS "${NODE_RUNTIME_LIB}" AND NOT NODE_RUNTIME_HEADER STREQUAL "")
  set(NODE_RUNTIME_AVAILABLE 1)
  message(STATUS "node-runtime: embedding ${NODE_RUNTIME_LIB} (headers from ${NODE_RUNTIME_HEADER})")
else()
  # Not an error: a JS-only dev client, an emulator ABI that was never
  # fetched, or a web build. The JNI stubs report "unavailable" at runtime.
  set(NODE_RUNTIME_AVAILABLE 0)
  message(WARNING
    "node-runtime: no embedded Node runtime for ABI '${ANDROID_ABI}'.\n"
    "  expected ${NODE_RUNTIME_LIB}\n"
    "  expected ${NODE_RUNTIME_INCLUDE}/node.h or ${NODE_RUNTIME_INCLUDE}/node/node.h\n"
    "  Run: node scripts/fetch-node-runtime.mjs --abis ${ANDROID_ABI}\n"
    "  Building a stub that reports the runtime as unavailable.")
endif()

add_library(noderuntime_jni SHARED node-runtime-jni.cpp)

target_compile_definitions(noderuntime_jni PRIVATE
  NODE_RUNTIME_AVAILABLE=${NODE_RUNTIME_AVAILABLE})

target_include_directories(noderuntime_jni PRIVATE ${NODE_RUNTIME_INCLUDE_DIRS})

find_library(log-lib log)
target_link_libraries(noderuntime_jni PRIVATE "${log-lib}")

if(NODE_RUNTIME_AVAILABLE)
  # Deliberately linked by *name* (a -L search path plus -lnode), not by the
  # absolute path of the .so. The linker records DT_NEEDED as the soname if the
  # library has one, and otherwise as the path it was given — so linking by
  # absolute path would bake the build machine's directory into the binary and
  # the dependency would fail to resolve on-device, where the runtime is
  # extracted to the app's native library dir under a name of `libnode.so`.
  get_filename_component(NODE_RUNTIME_LIB_DIR "${NODE_RUNTIME_LIB}" DIRECTORY)
  target_link_directories(noderuntime_jni PRIVATE "${NODE_RUNTIME_LIB_DIR}")
  target_link_libraries(noderuntime_jni PRIVATE node)
endif()
