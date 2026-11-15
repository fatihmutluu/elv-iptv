cmake_minimum_required(VERSION 3.22.1 FATAL_ERROR)

project(libffmpegJNI LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED FFMPEG_STAGE_DIR)
  message(FATAL_ERROR "FFMPEG_STAGE_DIR must point to staged FFmpeg prefix (<dir>/include, <dir>/lib)")
endif()

if(NOT DEFINED MEDIA3_JNI_SRC)
  message(FATAL_ERROR "MEDIA3_JNI_SRC must point to Media3 ffmpeg_jni.cc")
endif()

foreach(ffmpeg_lib IN ITEMS avutil swresample avcodec)
  add_library(${ffmpeg_lib} SHARED IMPORTED)
  set_target_properties(
    ${ffmpeg_lib}
    PROPERTIES IMPORTED_LOCATION "${FFMPEG_STAGE_DIR}/lib/lib${ffmpeg_lib}.so"
  )
endforeach()

find_library(android_log_lib log REQUIRED)

add_library(ffmpegJNI SHARED "${MEDIA3_JNI_SRC}")

target_include_directories(ffmpegJNI PRIVATE "${FFMPEG_STAGE_DIR}/include")

target_compile_options(
  ffmpegJNI
  PRIVATE
    -fno-exceptions
    -fno-rtti
    -Wall
    -Wextra
    -Wno-unused-parameter
)

set_target_properties(
  ffmpegJNI
  PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON
    OUTPUT_NAME "ffmpegJNI"
)

target_link_options(
  ffmpegJNI
  PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,--no-undefined"
    "-Wl,--no-as-needed"
)

if(ANDROID_ABI STREQUAL "arm64-v8a")
  target_link_options(ffmpegJNI PRIVATE "-Wl,-Bsymbolic")
endif()

target_link_libraries(
  ffmpegJNI
  PRIVATE
    avcodec
    swresample
    avutil
    "${android_log_lib}"
)
